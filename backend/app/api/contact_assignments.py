"""
Закрепление людей за «менеджером лидов» (миграция 484).

Владелец кабинета раздаёт своих людей сотрудникам: каждый ведёт свой кусок
базы. Менеджер видит в контактах и в CRM событий только закреплённых за ним.

⚠️ Закрепляем КОНТАКТ, а не участника события. Контакт — это человек, он один
на кабинет; участник — его запись в одном событии, и таких у человека столько,
во сколько событий он пришёл. Закрепление контакта работает сразу везде:
в базе контактов, в CRM любого события, в переписке.

⚠️ Раздаёт только ВЛАДЕЛЕЦ. Дай это право самим менеджерам — и любой перетянет
к себе чужих людей: в кабинете у всех одна база.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List

from app.auth import get_current_client
from app.database import get_db

router = APIRouter(prefix="/contact-assignments", tags=["Закрепление за менеджером"])


async def _require_owner(client: dict) -> int:
    """Раздавать людей может только владелец кабинета."""
    if client.get("role") == "assistant":
        raise HTTPException(403, "Распределять людей может только владелец кабинета.")
    return int(client["sub"])


@router.get("/managers", summary="Менеджеры лидов кабинета и сколько за кем закреплено")
async def list_managers(client=Depends(get_current_client), db=Depends(get_db)):
    client_id = await _require_owner(client)
    rows = await db.fetch(
        """SELECT g.id AS grant_id, a.id AS assistant_id, a.email, a.name,
                  (SELECT COUNT(*) FROM contact_assignments ca
                    WHERE ca.grant_id = g.id) AS assigned_count
             FROM assistant_grants g
             JOIN assistants a ON a.id = g.assistant_id
            WHERE g.client_id = $1 AND g.access_level = 'leads'
            ORDER BY a.email""",
        client_id,
    )
    return {"managers": [dict(r) for r in rows]}


class AssignBody(BaseModel):
    contact_ids: List[int]
    # None — снять закрепление (человек становится ничьим).
    grant_id: Optional[int] = None
    note: Optional[str] = None


@router.post("", summary="Закрепить людей за менеджером (или снять закрепление)")
async def assign_contacts(
    body: AssignBody, client=Depends(get_current_client), db=Depends(get_db),
):
    """Пачкой: выделил людей в списке → закрепил за менеджером.

    ⚠️ Один человек — один менеджер: повторное закрепление ПЕРЕПИСЫВАЕТ
    прежнее (ON CONFLICT DO UPDATE), а не добавляет второго. Иначе в CRM
    один и тот же человек попал бы к двоим, и оба стали бы ему писать.
    """
    client_id = await _require_owner(client)
    ids = [int(i) for i in (body.contact_ids or [])]
    if not ids:
        raise HTTPException(400, "Не выбрано ни одного человека")
    if len(ids) > 5000:
        raise HTTPException(400, "Слишком много людей за один раз (максимум 5000)")

    # Чужих людей закреплять нельзя — проверяем владение ВСЕМИ сразу.
    own = await db.fetchval(
        "SELECT COUNT(*) FROM contacts WHERE id = ANY($1::int[]) AND client_id = $2",
        ids, client_id,
    )
    if int(own or 0) != len(set(ids)):
        raise HTTPException(404, "Часть людей не найдена в вашей базе")

    # Снятие закрепления.
    if body.grant_id is None:
        removed = await db.execute(
            "DELETE FROM contact_assignments WHERE client_id = $1 AND contact_id = ANY($2::int[])",
            client_id, ids,
        )
        return {"ok": True, "assigned": 0, "removed": _affected(removed)}

    # Пропуск должен быть менеджером лидов ИМЕННО этого кабинета: иначе
    # владелец закрепил бы своих людей за помощником чужого кабинета.
    grant = await db.fetchrow(
        """SELECT g.id FROM assistant_grants g
            WHERE g.id = $1 AND g.client_id = $2 AND g.access_level = 'leads'""",
        int(body.grant_id), client_id,
    )
    if not grant:
        raise HTTPException(404, "Менеджер не найден в этом кабинете")

    await db.executemany(
        """INSERT INTO contact_assignments (client_id, contact_id, grant_id, assigned_by, note)
                VALUES ($1, $2, $3, 'owner', $4)
           ON CONFLICT (client_id, contact_id)
           DO UPDATE SET grant_id = EXCLUDED.grant_id,
                         assigned_at = NOW(),
                         assigned_by = 'owner',
                         note = EXCLUDED.note""",
        [(client_id, cid, int(body.grant_id), body.note) for cid in ids],
    )
    return {"ok": True, "assigned": len(set(ids)), "removed": 0}


class AutoAssignBody(BaseModel):
    event_id: int
    # Только посчитать и показать, что получится, ничего не закрепляя.
    dry_run: bool = False


@router.post("/auto", summary="Раздать участников события менеджерам автоматически")
async def auto_assign_event(
    body: AutoAssignBody, client=Depends(get_current_client), db=Depends(get_db),
):
    """Раздаёт участников события менеджерам лидов «с умом».

    Порядок правил задан владельцем (22.09.2026) и важен именно в этом порядке:

    1. **Привёл клиент-внедренец** — участник уходит ЕМУ. Он его и привёл,
       значит ему и вести: за своих приведённых он получает процент.
    2. **Участник уже клиент ПЛЮСОНА и у него УЖЕ есть внедренец** — не трогаем
       вовсе. Забрать клиента у его внедренца автораздачей нельзя: это чужая
       работа и чужие деньги.
    3. **Остальные** (реферовод не внедренец или его нет) — делим ПОРОВНУ между
       менеджерами.

    ⚠️ Правило 2 проверяется РАНЬШЕ третьего, иначе действующий клиент чужого
    внедренца попал бы в общую дележку.

    ⚠️ Уже закреплённых за кем-то в ЭТОМ кабинете не трогаем: автораздача
    добирает нераспределённых, а не тасует всех заново. Иначе каждый запуск
    перемешивал бы людей, с которыми менеджеры уже начали работать.

    ⚠️ Раздаёт только владелец (как и ручное закрепление): дай это менеджерам —
    и любой перетянет к себе чужих.
    """
    client_id = await _require_owner(client)

    ev = await db.fetchval(
        """SELECT 1 FROM events e
            WHERE e.id = $1 AND EXISTS (SELECT 1 FROM event_owners eo
                  WHERE eo.event_id = e.id AND eo.client_id = $2
                    AND eo.status = 'accepted')""",
        int(body.event_id), client_id)
    if not ev:
        raise HTTPException(404, "Событие не найдено")

    # Менеджеры лидов кабинета. ⚠️ Порядок постоянный (по grant_id): при
    # дележке поровну остаток должен доставаться предсказуемо, а не случайно.
    managers = await db.fetch(
        """SELECT g.id AS grant_id, a.name, a.email,
                  -- Кабинет ПЛЮСОНА этого человека и его роль внедренца:
                  -- по ним узнаём «он привёл — ему и отдать».
                  (SELECT ts.client_id FROM tech_specialists ts
                     JOIN clients tc ON tc.id = ts.client_id
                    WHERE LOWER(TRIM(tc.email)) = LOWER(TRIM(a.email))
                      AND ts.is_active) AS tech_client_id
             FROM assistant_grants g
             JOIN assistants a ON a.id = g.assistant_id
            WHERE g.client_id = $1 AND g.access_level = 'leads'
            ORDER BY g.id""",
        client_id)
    if not managers:
        raise HTTPException(400, "В кабинете нет ни одного менеджера лидов. "
                                 "Сначала выдайте кому-нибудь эту роль.")

    # Участники события со всем, что нужно для решения.
    rows = await db.fetch(
        """SELECT c.id AS contact_id,
                  -- Кабинет ПЛЮСОНА того, кто привёл (если привёл клиент).
                  rc.linked_client_id AS referrer_client_id,
                  -- Свой внедренец у участника, если он сам клиент ПЛЮСОНА.
                  (SELECT pc.tech_specialist_id FROM clients pc
                    WHERE pc.id = c.linked_client_id) AS own_tech_id,
                  -- Уже закреплён в этом кабинете?
                  (SELECT ca.grant_id FROM contact_assignments ca
                    WHERE ca.client_id = $2 AND ca.contact_id = c.id) AS cur_grant
             FROM event_participants ep
             JOIN contacts c ON c.id = ep.contact_id
             LEFT JOIN event_participants rep ON rep.id = ep.referrer_participant_id
             LEFT JOIN contacts rc ON rc.id = rep.contact_id
            WHERE ep.event_id = $1 AND c.client_id = $2
            ORDER BY ep.id""",
        int(body.event_id), client_id)

    # grant_id по кабинету ПЛЮСОНА внедренца — для правила 1.
    by_tech_client = {m["tech_client_id"]: m["grant_id"]
                      for m in managers if m["tech_client_id"]}

    plan: dict[int, int] = {}        # contact_id → grant_id
    skipped_has_tech = 0             # правило 2
    skipped_assigned = 0             # уже закреплён
    to_share: list[int] = []         # правило 3

    for r in rows:
        cid = r["contact_id"]
        if r["cur_grant"]:
            skipped_assigned += 1
            continue
        # 1. Привёл внедренец — ему же.
        gid = by_tech_client.get(r["referrer_client_id"])
        if gid:
            plan[cid] = gid
            continue
        # 2. Уже клиент ПЛЮСОНА со своим внедренцем — не трогаем.
        if r["own_tech_id"]:
            skipped_has_tech += 1
            continue
        # 3. Остальные — в общую дележку.
        to_share.append(cid)

    # Делим поровну. ⚠️ Начинаем с наименее загруженного — иначе при повторных
    # запусках первый в списке набирал бы всех новых.
    #
    # ⚠️⚠️ «ПОРОВНУ» СЧИТАЕТСЯ ПО ИТОГОВОЙ НАГРУЗКЕ, А НЕ ПО ЭТОЙ ПОРЦИИ —
    # учитываем уже закреплённых за менеджером людей (в том числе по другим
    # событиям). Поэтому в раскладе новичок получает БОЛЬШЕ остальных, и это
    # верно: у четверых уже было по 21 человеку, у пятого ноль — после раздачи
    # у всех стало по 45–46. Делёж только текущей порции оставил бы новичка
    # вечно недогруженным, а «поровну» перестало бы означать равную работу.
    loads = {m["grant_id"]: 0 for m in managers}
    for gid in plan.values():
        loads[gid] = loads.get(gid, 0) + 1
    existing = await db.fetch(
        """SELECT grant_id, COUNT(*) AS n FROM contact_assignments
            WHERE client_id = $1 GROUP BY grant_id""", client_id)
    for e in existing:
        if e["grant_id"] in loads:
            loads[e["grant_id"]] += int(e["n"])

    for cid in to_share:
        gid = min(loads, key=lambda g: (loads[g], g))
        plan[cid] = gid
        loads[gid] += 1

    names = {m["grant_id"]: (m["name"] or m["email"]) for m in managers}
    per_manager = {}
    for gid in plan.values():
        per_manager[gid] = per_manager.get(gid, 0) + 1

    result = {
        "ok": True,
        "total_participants": len(rows),
        "assigned": len(plan),
        "skipped_already_assigned": skipped_assigned,
        "skipped_has_own_tech": skipped_has_tech,
        "by_manager": [
            {"grant_id": g, "name": names.get(g, "?"), "count": n}
            for g, n in sorted(per_manager.items(), key=lambda kv: -kv[1])
        ],
        "dry_run": body.dry_run,
    }
    if body.dry_run or not plan:
        return result

    await db.executemany(
        """INSERT INTO contact_assignments (client_id, contact_id, grant_id, assigned_by, note)
                VALUES ($1, $2, $3, 'owner', 'автораспределение')
           ON CONFLICT (client_id, contact_id)
           DO UPDATE SET grant_id = EXCLUDED.grant_id,
                         assigned_at = NOW(),
                         assigned_by = 'owner',
                         note = EXCLUDED.note""",
        [(client_id, cid, gid) for cid, gid in plan.items()],
    )
    return result


def _affected(status: str) -> int:
    """Сколько строк тронула команда: asyncpg возвращает строку вида 'DELETE 12'."""
    try:
        return int(str(status).rsplit(" ", 1)[-1])
    except (ValueError, IndexError):
        return 0


@router.get("", summary="За кем закреплены люди (для подписей в списке)")
async def get_assignments(
    contact_ids: str = "", client=Depends(get_current_client), db=Depends(get_db),
):
    """`contact_ids` — CSV номеров. Отдаёт карту «номер человека → менеджер».

    ⚠️ Одним запросом на весь показанный список, а не по человеку: список
    контактов грузится по 50 строк, и 50 отдельных запросов на подписи
    заметно тормозили бы открытие раздела.
    """
    client_id = await _require_owner(client)
    ids = [int(x) for x in contact_ids.split(",") if x.strip().isdigit()]
    if not ids:
        return {"assignments": {}}
    rows = await db.fetch(
        """SELECT ca.contact_id, ca.grant_id, a.email, a.name
             FROM contact_assignments ca
             JOIN assistant_grants g ON g.id = ca.grant_id
             JOIN assistants a ON a.id = g.assistant_id
            WHERE ca.client_id = $1 AND ca.contact_id = ANY($2::int[])""",
        client_id, ids,
    )
    return {
        "assignments": {
            str(r["contact_id"]): {
                "grant_id": r["grant_id"],
                "email": r["email"],
                "name": r["name"],
            }
            for r in rows
        }
    }
