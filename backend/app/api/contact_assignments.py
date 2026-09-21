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
