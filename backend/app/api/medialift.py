"""МедиаЛифт — многоуровневая система автоподписки (тип события module_slug='medialift').

Служебный тип события на сервисном клиенте (clients.is_system_service=TRUE).
Виральная воронка: человек заходит по чьей-то реф-ссылке → ему показывают до 7
участников из его ветки (кто над ним по реф-цепочке) → он обязан подписаться на 3
→ регистрируется → сам добавляет свой канал (становится карточкой-коллаборатором).

Реф-цепочка НЕ хранится отдельной таблицей — считается на лету по
event_participants.referrer_ref_code (строка) → contacts.ref_code → следующий вверх.

Карточка участника = collaborators + event_collaborators этого события (как спикер):
- tg_channel_url / tg_channel_id — канал (название подтягивается на лету, не хранится),
- hub_about — описание («о себе»),
- фото/подарок — только у тех, кто стал клиентом ПЛЮСОНа (linked_client_id).
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from app.database import get_db
from app.auth import get_current_client
import asyncpg
import httpx
from typing import Optional

router = APIRouter(prefix="/api/v1/public/medialift", tags=["МедиаЛифт"])
# Клиентский роутер (кабинет ПЛЮСОНа): моя карточка в МедиаЛифте + выбор лид-магнита.
client_router = APIRouter(prefix="/api/v1/clients/me/medialift", tags=["МедиаЛифт (кабинет)"])

# Сколько человек из ветки показываем максимум и сколько подписок минимум обязательно.
CHAIN_DEPTH = 7          # до 7 человек вверх по реф-цепочке
MIN_SUBSCRIBE = 3        # обязательная подписка на 3


async def _resolve_chain_contact_ids(
    db: asyncpg.Connection, event_id: int, start_contact_id: Optional[int]
) -> list[int]:
    """Цепочка contact_id вверх от зашедшего человека (кто его привёл, кто привёл
    того и т.д.), до CHAIN_DEPTH штук. Считается по referrer_ref_code рекурсивно.

    start_contact_id — контакт зашедшего в этом событии (может быть None, если
    человек ещё не участник — тогда ветки нет, вернём пусто → добор сработает).
    """
    if not start_contact_id:
        return []
    rows = await db.fetch(
        """
        WITH RECURSIVE chain AS (
            -- уровень 0: сам зашедший (его participant в этом событии)
            SELECT ep.contact_id, ep.referrer_ref_code, 0 AS depth
              FROM event_participants ep
             WHERE ep.event_id = $1 AND ep.contact_id = $2
            UNION ALL
            -- шаг вверх: по referrer_ref_code находим контакт-рефовода,
            -- затем его participant в ЭТОМ событии (чтобы взять его referrer_ref_code)
            SELECT rc.id, up.referrer_ref_code, ch.depth + 1
              FROM chain ch
              JOIN contacts rc ON rc.ref_code = ch.referrer_ref_code
              LEFT JOIN event_participants up
                     ON up.event_id = $1 AND up.contact_id = rc.id
             WHERE ch.referrer_ref_code IS NOT NULL
               AND ch.referrer_ref_code <> ''
               AND ch.depth < $3
        )
        -- берём предков (depth>0), сам зашедший (depth=0) не показывается себе
        SELECT DISTINCT contact_id, MIN(depth) AS depth
          FROM chain
         WHERE depth > 0
         GROUP BY contact_id
         ORDER BY depth ASC
         LIMIT $3
        """,
        event_id, start_contact_id, CHAIN_DEPTH,
    )
    return [r["contact_id"] for r in rows]


async def _fetch_cards(
    db: asyncpg.Connection, event_id: int, contact_ids: list[int], limit: int
) -> list[dict]:
    """Карточки участников МедиаЛифта (коллабораторы события) по списку contact_id.
    Если contact_ids заданы — берём именно их (ветка), сортировка по порядку списка.
    Порядок карточки повторяет карточку спикера (адаптивная: канал/описание/фото/подарок)."""
    if not contact_ids:
        return []
    rows = await db.fetch(
        """
        SELECT ec.id                AS ec_id,
               c.id                 AS collaborator_id,
               ct.id                AS contact_id,
               ct.name              AS name,
               NULL AS description,
               c.tg_channel_url     AS tg_channel_url,
               c.tg_channel_id      AS tg_channel_id,
               c.photo_url          AS photo_url,
               c.linked_client_id   AS linked_client_id,
               ec.gift_lead_magnet_id AS gift_lead_magnet_id,
               ct.ref_code          AS ref_code
          FROM event_collaborators ec
          JOIN collaborators c  ON c.id = ec.speaker_id
          JOIN contacts ct      ON ct.id = c.contact_id
         WHERE ec.event_id = $1
           AND ct.id = ANY($2::int[])
           AND COALESCE(ec.is_visible, TRUE) = TRUE
        """,
        event_id, contact_ids,
    )
    by_contact = {r["contact_id"]: r for r in rows}
    ordered = [by_contact[cid] for cid in contact_ids if cid in by_contact]
    return [dict(r) for r in ordered[:limit]]


async def _fill_recent(
    db: asyncpg.Connection, event_id: int, exclude_contact_ids: list[int], need: int
) -> list[dict]:
    """Добор (вариант C): свежие коллабораторы события, которых ещё нет в ветке.
    Берём последних добавленных, исключая уже показанных и самого зашедшего."""
    if need <= 0:
        return []
    rows = await db.fetch(
        """
        SELECT ec.id                AS ec_id,
               c.id                 AS collaborator_id,
               ct.id                AS contact_id,
               ct.name              AS name,
               NULL AS description,
               c.tg_channel_url     AS tg_channel_url,
               c.tg_channel_id      AS tg_channel_id,
               c.photo_url          AS photo_url,
               c.linked_client_id   AS linked_client_id,
               ec.gift_lead_magnet_id AS gift_lead_magnet_id,
               ct.ref_code          AS ref_code
          FROM event_collaborators ec
          JOIN collaborators c  ON c.id = ec.speaker_id
          JOIN contacts ct      ON ct.id = c.contact_id
         WHERE ec.event_id = $1
           AND COALESCE(ec.is_visible, TRUE) = TRUE
           AND NOT (ct.id = ANY($2::int[]))
           AND c.tg_channel_url IS NOT NULL
           AND c.tg_channel_url <> ''
         ORDER BY ec.id DESC
         LIMIT $3
        """,
        event_id, exclude_contact_ids or [0], need,
    )
    return [dict(r) for r in rows]


@router.get("/{slug}/chain", summary="Ветка участников МедиаЛифта для зашедшего (до 7, подписка на 3)")
async def get_chain(
    slug: str,
    contact_id: Optional[int] = Query(None, description="contact_id зашедшего (если известен)"),
    db: asyncpg.Connection = Depends(get_db),
):
    """Отдаёт до 7 карточек участников из ветки над зашедшим + сколько подписок
    обязательно (3). Если в ветке < 3 — добираем свежими (вариант C)."""
    ev = await db.fetchrow(
        "SELECT id, module_slug, medialift_required_subscriptions FROM events WHERE slug = $1", slug)
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    if ev["module_slug"] != "medialift":
        raise HTTPException(status_code=400, detail="Это не событие МедиаЛифт")
    event_id = ev["id"]
    # Сколько подписок обязательно — свойство события (миграция 211), дефолт 3.
    min_sub = ev["medialift_required_subscriptions"] or MIN_SUBSCRIBE

    chain_ids = await _resolve_chain_contact_ids(db, event_id, contact_id)
    cards = await _fetch_cards(db, event_id, chain_ids, CHAIN_DEPTH)

    # Добор C: пока карточек < min_sub — добираем свежими.
    if len(cards) < min_sub:
        shown = [c["contact_id"] for c in cards]
        if contact_id:
            shown.append(contact_id)
        need = min_sub - len(cards)
        cards += await _fill_recent(db, event_id, shown, need)

    required = min(min_sub, len(cards))
    return {
        "event_id": event_id,
        "required_subscriptions": required,
        "cards": cards,
    }


# ── Проверка подписки на выбранные каналы (гейт регистрации: подпишись на 3) ──

_SUBSCRIBED_STATUSES = ("member", "administrator", "creator", "restricted")


class CheckSubscribeIn(BaseModel):
    tg_id: int
    collaborator_ids: list[int]   # какие карточки участник выбрал для подписки


async def _tg_get_chat_member(http: httpx.AsyncClient, token: str, channel_id: str, user_id: int) -> tuple[bool, str]:
    """(ok, status). ok=False = Telegram не дал данные (бот не админ/канал недоступен)."""
    try:
        r = await http.get(
            f"https://api.telegram.org/bot{token}/getChatMember",
            params={"chat_id": channel_id, "user_id": user_id}, timeout=5.0)
        data = r.json()
        if not data.get("ok"):
            return False, ""
        return True, ((data.get("result") or {}).get("status") or "")
    except Exception:
        return False, ""


@router.post("/{slug}/check-subscribe", summary="Проверить подписку зашедшего на выбранные каналы")
async def check_subscribe(
    slug: str,
    data: CheckSubscribeIn,
    db: asyncpg.Connection = Depends(get_db),
):
    """Проверяет, подписан ли зашедший (tg_id) на TG-каналы выбранных карточек.
    Проверка идёт ботом сервисного клиента (владельца события). Канал, где бот не
    админ (не может подтвердить подписку) — считаем 'ok' (fail-open, как в
    subscription_check: не блокируем из-за чужой ошибки настройки)."""
    from app.services.channels import get_client_telegram_token

    ev = await db.fetchrow(
        """SELECT e.id, e.module_slug, eo.client_id AS owner_client_id
             FROM events e
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status='accepted'
            WHERE e.slug = $1
            ORDER BY eo.id LIMIT 1""", slug)
    if not ev or ev["module_slug"] != "medialift":
        raise HTTPException(status_code=404, detail="Событие МедиаЛифт не найдено")
    event_id = ev["id"]

    if not data.collaborator_ids:
        return {"ok": True, "confirmed": 0, "not_subscribed": []}

    # Каналы выбранных карточек + personal_tg_id владельца канала (для viability).
    rows = await db.fetch(
        """SELECT c.id AS collaborator_id, ct.name AS name,
                  c.tg_channel_id, c.tg_channel_url,
                  pu.platform_user_id AS owner_tg_id
             FROM event_collaborators ec
             JOIN collaborators c ON c.id = ec.speaker_id
             JOIN contacts ct ON ct.id = c.contact_id
             LEFT JOIN platform_users pu
               ON pu.contact_id = c.contact_id AND pu.platform_slug='telegram'
            WHERE ec.event_id = $1
              AND c.id = ANY($2::int[])
              AND c.tg_channel_id IS NOT NULL AND c.tg_channel_id <> ''""",
        event_id, data.collaborator_ids)

    token = await get_client_telegram_token(ev["owner_client_id"], db)
    if not token:
        # Нет бота у сервисного клиента — проверить нечем, пропускаем (fail-open).
        return {"ok": True, "confirmed": len(rows), "not_subscribed": []}

    not_subscribed = []
    confirmed = 0
    async with httpx.AsyncClient() as http:
        for r in rows:
            owner_tg = r["owner_tg_id"]
            # viability: бот видит подписки канала? (проверяем на владельце канала)
            if owner_tg:
                vok, vst = await _tg_get_chat_member(http, token, r["tg_channel_id"], int(owner_tg))
                if not vok or vst not in _SUBSCRIBED_STATUSES:
                    confirmed += 1  # бот не админ → fail-open, засчитываем
                    continue
            uok, ust = await _tg_get_chat_member(http, token, r["tg_channel_id"], data.tg_id)
            if uok and ust in _SUBSCRIBED_STATUSES:
                confirmed += 1
            else:
                not_subscribed.append({
                    "collaborator_id": r["collaborator_id"],
                    "name": r["name"],
                    "tg_channel_url": r["tg_channel_url"],
                })

    return {
        "ok": len(not_subscribed) == 0,
        "confirmed": confirmed,
        "not_subscribed": not_subscribed,
    }


# ── Самозапись «добавь свой канал» (человек сам становится карточкой) ──

class AddChannelIn(BaseModel):
    tg_id: int
    tg_channel_url: str            # ссылка на его Telegram-канал
    description: Optional[str] = None   # «о себе» (регалии), опционально


async def _resolve_channel(http: httpx.AsyncClient, token: str, url: str) -> tuple[Optional[str], Optional[str]]:
    """По ссылке на канал возвращает (tg_channel_id, title) через getChat.
    Название НЕ храним — берём на лету; но id храним (нужен для getChatMember)."""
    m = (url or "").replace("https://telegram.me/", "").replace("http://telegram.me/", "").replace("https://t.me/", "").replace("http://t.me/", "").lstrip("@/").split("/")[0].split("?")[0]
    if not m or m.startswith("+"):
        return None, None
    try:
        r = await http.get(f"https://api.telegram.org/bot{token}/getChat",
                            params={"chat_id": f"@{m}"}, timeout=6.0)
        d = r.json()
        if d.get("ok") and (d.get("result") or {}).get("id"):
            res = d["result"]
            return str(res["id"]), (res.get("title") or "")
    except Exception:
        pass
    return None, None


@router.post("/{slug}/add-channel", summary="Участник сам добавляет свой канал → становится карточкой")
async def add_channel(
    slug: str,
    data: AddChannelIn,
    db: asyncpg.Connection = Depends(get_db),
):
    """Человек (уже зарегистрированный участник) добавляет свой TG-канал →
    создаётся/обновляется его карточка-коллаборатор в событии МедиаЛифт.
    Автосвязка с клиентским аккаунтом ПЛЮСОНа — по числовому tg_id (если у него
    уже есть аккаунт с тем же tg_id → linked_client_id молча)."""
    from app.services.speaker_self_register import complete_speaker_self_register
    from app.services.channels import get_client_telegram_token

    ev = await db.fetchrow(
        """SELECT e.id, e.module_slug, eo.client_id AS owner_client_id
             FROM events e
             JOIN event_owners eo ON eo.event_id = e.id AND eo.status='accepted'
            WHERE e.slug=$1 ORDER BY eo.id LIMIT 1""", slug)
    if not ev or ev["module_slug"] != "medialift":
        raise HTTPException(status_code=404, detail="Событие МедиаЛифт не найдено")
    owner_client_id = ev["owner_client_id"]

    # contact зашедшего в базе сервисного клиента (создан при регистрации).
    contact = await db.fetchrow(
        """SELECT ct.id, ct.name
             FROM platform_users pu
             JOIN contacts ct ON ct.id = pu.contact_id
            WHERE ct.client_id = $1 AND pu.platform_slug='telegram'
              AND pu.platform_user_id = $2::text
            LIMIT 1""",
        owner_client_id, str(data.tg_id))
    if not contact:
        raise HTTPException(status_code=400, detail="Сначала зарегистрируйтесь в системе через бота")
    contact_id = contact["id"]

    # Создаём/находим карточку-коллаборатора в событии (переиспуск самозаписи спикера).
    collaborator_id, access_code, event_slug, _was = await complete_speaker_self_register(
        db, event_id=ev["id"], client_id=owner_client_id,
        contact_id=contact_id, contact_name=contact["name"] or "Участник")

    # Резолвим id канала (для проверки подписки следующими) + сохраняем ссылку/описание.
    token = await get_client_telegram_token(owner_client_id, db)
    channel_id, title = (None, None)
    if token:
        async with httpx.AsyncClient() as http:
            channel_id, title = await _resolve_channel(http, token, data.tg_channel_url)

    await db.execute(
        """UPDATE collaborators
              SET tg_channel_url = $1,
                  tg_channel_id  = COALESCE($2, tg_channel_id),
                  updated_at     = NOW()
            WHERE id = $3""",
        data.tg_channel_url.strip(), channel_id, collaborator_id)

    # Автосвязка с клиентским аккаунтом ПЛЮСОНа по числовому tg_id.
    # Если у человека уже есть свой client-аккаунт с этим же tg_id — привязываем молча.
    linked = await db.fetchval(
        """SELECT ct.client_id
             FROM platform_users pu
             JOIN contacts ct ON ct.id = pu.contact_id
             JOIN clients cl ON cl.id = ct.client_id
            WHERE pu.platform_slug='telegram' AND pu.platform_user_id=$1::text
              AND cl.is_system_service = FALSE
            ORDER BY ct.client_id LIMIT 1""",
        str(data.tg_id))
    if linked:
        await db.execute(
            "UPDATE collaborators SET linked_client_id=$1 WHERE id=$2 AND linked_client_id IS NULL",
            linked, collaborator_id)

    return {
        "ok": True,
        "collaborator_id": collaborator_id,
        "contact_id": contact_id,      # для открытия кабинета в Mini App
        "channel_title": title,        # авто-название (не храним, отдаём разово)
        "linked_client_id": linked,    # если авто-связка сработала
        "access_code": access_code,    # для входа в кабинет правки карточки
    }


# ─────────── Кабинет клиента: моя карточка в МедиаЛифте + выбор лид-магнита ───────────

class MyCardGiftIn(BaseModel):
    lead_magnet_id: Optional[int] = None  # 0/None — снять подарок


@client_router.get("/my-card", summary="Моя карточка в МедиаЛифте (если связана) + мои лид-магниты")
async def my_medialift_card(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Клиент ПЛЮСОНа видит свою карточку-коллаба в событии МедиаЛифт (если она
    связана с его аккаунтом через collaborators.linked_client_id) и может выбрать
    свой лид-магнит, который покажется в карточке как подарок за подписку.

    Связь появляется автоматически при регистрации из воронки (ml_tg_id) либо
    вручную по числовому tg_id. Нет карточки → linked=False (блок не показываем)."""
    client_id = int(client["sub"])
    row = await db.fetchrow(
        """SELECT c.id AS collaborator_id, ec.id AS ec_id, ec.event_id,
                  c.name, c.tg_channel_url, ec.gift_lead_magnet_id
             FROM collaborators c
             JOIN event_collaborators ec ON ec.speaker_id = c.id
             JOIN events e ON e.id = ec.event_id AND e.module_slug = 'medialift'
            WHERE c.linked_client_id = $1
            LIMIT 1""", client_id)
    if not row:
        return {"linked": False, "card": None, "lead_magnets": []}

    lms = await db.fetch(
        "SELECT id, name FROM lead_magnets WHERE client_id = $1 ORDER BY id DESC", client_id)
    return {
        "linked": True,
        "card": {
            "collaborator_id": row["collaborator_id"],
            "name": row["name"],
            "tg_channel_url": row["tg_channel_url"],
            "gift_lead_magnet_id": row["gift_lead_magnet_id"],
        },
        "lead_magnets": [dict(r) for r in lms],
    }


@client_router.patch("/my-card/gift", summary="Выбрать лид-магнит для своей карточки МедиаЛифта")
async def set_my_card_gift(
    data: MyCardGiftIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    ec = await db.fetchrow(
        """SELECT ec.id FROM event_collaborators ec
             JOIN collaborators c ON c.id = ec.speaker_id
             JOIN events e ON e.id = ec.event_id AND e.module_slug = 'medialift'
            WHERE c.linked_client_id = $1 LIMIT 1""", client_id)
    if not ec:
        raise HTTPException(status_code=404, detail="Ваша карточка в МедиаЛифте не найдена")

    lm_id = data.lead_magnet_id or None
    if lm_id:
        owned = await db.fetchval(
            "SELECT 1 FROM lead_magnets WHERE id = $1 AND client_id = $2", lm_id, client_id)
        if not owned:
            raise HTTPException(status_code=400, detail="Это не ваш лид-магнит")
    await db.execute(
        "UPDATE event_collaborators SET gift_lead_magnet_id = $1 WHERE id = $2", lm_id, ec["id"])
    return {"ok": True, "gift_lead_magnet_id": lm_id}


# ─────────── Кабинет участника МедиаЛифта: статистика + ссылка + материалы ───────────

@router.get("/{slug}/my-cabinet", summary="Кабинет участника: ссылка, материалы, статистика")
async def my_cabinet(
    slug: str,
    contact_id: int = Query(..., description="contact_id участника (из ссылки)"),
    db: asyncpg.Connection = Depends(get_db),
):
    """Личный кабинет участника МедиаЛифта: его реф-ссылка, готовые материалы,
    статистика (кто перешёл/подписался, охват его ветки, всего в системе)."""
    ev = await db.fetchrow(
        """SELECT e.id, e.module_slug, e.title,
                  eo.client_id AS owner_client_id
             FROM events e
             JOIN event_owners eo ON eo.event_id=e.id AND eo.status='accepted'
            WHERE e.slug=$1 ORDER BY eo.id LIMIT 1""", slug)
    if not ev or ev["module_slug"] != "medialift":
        raise HTTPException(status_code=404, detail="Событие МедиаЛифт не найдено")
    event_id = ev["id"]

    me = await db.fetchrow(
        "SELECT id, name, ref_code FROM contacts WHERE id=$1", contact_id)
    if not me:
        raise HTTPException(status_code=404, detail="Участник не найден")
    ref_code = me["ref_code"]

    # 1) Кто пришёл по МОЕЙ ссылке (прямые приглашённые) — и сколько из них
    #    реально зарегистрировались (= подписались и вошли).
    direct = await db.fetchrow(
        """SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE is_registered) AS registered
             FROM event_participants
            WHERE event_id=$1 AND referrer_ref_code=$2""",
        event_id, ref_code)

    # 2) Охват ВСЕЙ ветки под мной (рекурсия вниз по referrer_ref_code).
    branch = await db.fetchval(
        """
        WITH RECURSIVE down AS (
            SELECT ep.contact_id, c.ref_code
              FROM event_participants ep
              JOIN contacts c ON c.id = ep.contact_id
             WHERE ep.event_id=$1 AND ep.referrer_ref_code=$2
            UNION
            SELECT ep.contact_id, c.ref_code
              FROM down d
              JOIN event_participants ep ON ep.event_id=$1 AND ep.referrer_ref_code=d.ref_code
              JOIN contacts c ON c.id = ep.contact_id
        )
        SELECT COUNT(DISTINCT contact_id) FROM down
        """, event_id, ref_code) or 0

    # 3) Всего людей в системе МедиаЛифт.
    total_system = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE event_id=$1", event_id) or 0

    # Реф-ссылка участника (вход в воронку под ним) — через бот сервисного клиента.
    from app.services.share_links import build_share_links
    links = await build_share_links(
        db, client_id=ev["owner_client_id"], event_slug=slug, partner_id=ref_code)

    # Готовые материалы-тексты события (шеринг) — как в кабинете спикера.
    texts = await db.fetch(
        "SELECT content FROM event_referral_share_texts WHERE event_id=$1 ORDER BY sort, id", event_id)

    return {
        "event_title": ev["title"],
        "name": me["name"],
        "ref_code": ref_code,
        "link": links.get("telegram") or "",
        "share_texts": [r["content"] for r in texts],
        "stats": {
            "clicked": direct["total"],            # перешли по вашей ссылке
            "joined": direct["registered"],        # из них подписались и вошли
            "branch_reach": branch,                # всего под вами в ветке
            "total_system": total_system,          # всего в системе МедиаЛифт
        },
    }
