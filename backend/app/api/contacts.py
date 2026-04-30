"""
API контактов (миграция 036+ — иерархия Контактов).

Источник истины — таблица `contacts`. Идентичности (`platform_users`)
JOIN'ятся для отображения username и подписок на каналы.
"""
import json
from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel
from app.auth import get_current_client
from app.database import get_db
from app.services.contact_merge import merge_contacts


def parse_tags(tags):
    if tags is None:
        return None
    if isinstance(tags, list):
        return tags
    try:
        return json.loads(tags)
    except Exception:
        return []


router = APIRouter()


def _split_csv(val: str | None) -> list[str]:
    """Парсит query-параметр вида 'a,b,c' в список ['a','b','c']."""
    if not val:
        return []
    return [x.strip() for x in val.split(",") if x.strip()]


@router.get("/contacts")
async def get_contacts(
    search: str = Query(default="", alias="search"),
    limit: int = Query(default=50),
    offset: int = Query(default=0),
    show_unsubscribed: bool = Query(default=False),
    subscription: str = Query(default="any", description="any | subscribed | unsubscribed"),
    platforms: str | None = Query(default=None, description="CSV slug-ов платформ: telegram,vk"),
    channel_ids: str | None = Query(default=None, description="CSV id каналов клиента"),
    utm_sources: str | None = Query(default=None, description="CSV utm_source значений"),
    tags: str | None = Query(default=None, description="CSV тегов (любой из них)"),
    date_from: str | None = Query(default=None, description="ISO дата >= last_contact_at"),
    date_to: str | None = Query(default=None, description="ISO дата <= last_contact_at"),
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    """
    Список контактов клиента. Поиск идёт по contacts.name/email/phone +
    по username/first_name/last_name любой идентичности контакта.

    Дополнительные фильтры (см. query-параметры): платформы, конкретные каналы
    подписки, utm_source, теги, диапазон по last_contact_at, состояние подписки.
    """
    client_id = int(client["sub"])

    where_base = "WHERE c.client_id = $1 AND c.is_active = TRUE"
    params = [client_id]

    if search:
        params.append(f"%{search}%")
        idx = len(params)
        where_base += f"""
          AND (
            c.name ILIKE ${idx} OR c.email ILIKE ${idx} OR c.phone ILIKE ${idx}
            OR EXISTS (
                SELECT 1 FROM platform_users pu
                 WHERE pu.contact_id = c.id
                   AND (pu.username ILIKE ${idx} OR pu.first_name ILIKE ${idx} OR pu.last_name ILIKE ${idx})
            )
          )
        """

    # Фильтр по платформам идентичностей: контакт должен иметь хоть одну
    # идентичность на одной из выбранных платформ.
    platforms_list = _split_csv(platforms)
    if platforms_list:
        params.append(platforms_list)
        idx = len(params)
        where_base += f"""
          AND EXISTS (
            SELECT 1 FROM platform_users pu
             WHERE pu.contact_id = c.id AND pu.platform_slug = ANY(${idx}::text[])
          )
        """

    # Фильтр по каналам: контакт подписан хотя бы на один из выбранных каналов
    # (запись в platform_user_channels с is_unsubscribed = FALSE).
    channel_ids_raw = _split_csv(channel_ids)
    channel_ids_int: list[int] = []
    for x in channel_ids_raw:
        try:
            channel_ids_int.append(int(x))
        except ValueError:
            pass
    if channel_ids_int:
        params.append(channel_ids_int)
        idx = len(params)
        where_base += f"""
          AND EXISTS (
            SELECT 1 FROM platform_users pu
            JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
             WHERE pu.contact_id = c.id
               AND puc.channel_id = ANY(${idx}::int[])
               AND puc.is_unsubscribed = FALSE
          )
        """

    # UTM source — точное совпадение из выбранных значений
    utm_list = _split_csv(utm_sources)
    if utm_list:
        params.append(utm_list)
        idx = len(params)
        where_base += f" AND c.utm_source = ANY(${idx}::text[])"

    # Теги — JSONB, проверка «есть хотя бы один из выбранных»
    tags_list = _split_csv(tags)
    if tags_list:
        params.append(tags_list)
        idx = len(params)
        where_base += f" AND c.tags ?| ${idx}::text[]"

    # Диапазон по last_contact_at
    if date_from:
        params.append(date_from)
        idx = len(params)
        where_base += f" AND c.last_contact_at >= ${idx}::timestamptz"
    if date_to:
        params.append(date_to)
        idx = len(params)
        where_base += f" AND c.last_contact_at <= ${idx}::timestamptz"

    # Считаем что контакт «отписался», если у него все подписки отписаны
    # (есть хотя бы одна с unsub=TRUE и нет ни одной с unsub=FALSE).
    # Если подписок нет вообще — считаем подписанным (по умолчанию).
    UNSUB_EXISTS = """(EXISTS (
        SELECT 1 FROM platform_users pu
        JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
        JOIN channels ch ON ch.id = puc.channel_id
        WHERE pu.contact_id = c.id AND ch.client_id = c.client_id
          AND puc.is_unsubscribed = TRUE
    ) AND NOT EXISTS (
        SELECT 1 FROM platform_users pu
        JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
        JOIN channels ch ON ch.id = puc.channel_id
        WHERE pu.contact_id = c.id AND ch.client_id = c.client_id
          AND puc.is_unsubscribed = FALSE
    ))"""

    where = where_base
    # Параметр subscription приоритетнее show_unsubscribed (последний оставлен
    # для обратной совместимости со старым фронтом).
    sub_state = (subscription or "any").lower()
    if sub_state == "subscribed":
        where += f" AND NOT {UNSUB_EXISTS}"
    elif sub_state == "unsubscribed":
        where += f" AND {UNSUB_EXISTS}"
    elif sub_state == "any":
        if not show_unsubscribed:
            where += f" AND NOT {UNSUB_EXISTS}"

    total = await db.fetchval(f"SELECT COUNT(*) FROM contacts c {where}", *params)
    total_all = await db.fetchval(f"SELECT COUNT(*) FROM contacts c {where_base}", *params)
    subscribed = await db.fetchval(
        f"SELECT COUNT(*) FROM contacts c {where_base} AND NOT {UNSUB_EXISTS}", *params
    )
    unsubscribed = await db.fetchval(
        f"SELECT COUNT(*) FROM contacts c {where_base} AND {UNSUB_EXISTS}", *params
    )

    rows = await db.fetch(f"""
        SELECT
          c.id,
          c.name,
          c.email,
          c.phone,
          c.utm_source,
          c.tags,
          c.ref_code,
          c.salebot_id,
          c.last_contact_at,
          c.created_at,
          (SELECT name FROM contacts ref
            WHERE ref.id = c.first_referrer_contact_id LIMIT 1) AS referrer_name,
          (SELECT json_agg(json_build_object(
              'platform_slug', pu.platform_slug,
              'platform_user_id', pu.platform_user_id,
              'username', pu.username,
              'first_name', pu.first_name,
              'last_name', pu.last_name
            ) ORDER BY pu.platform_slug)
            FROM platform_users pu WHERE pu.contact_id = c.id) AS identities,
          {UNSUB_EXISTS} AS is_unsubscribed,
          EXISTS (
            SELECT 1 FROM event_participants ep WHERE ep.contact_id = c.id
          ) AS is_participant
        FROM contacts c
        {where}
        ORDER BY c.name NULLS LAST, c.id
        LIMIT ${len(params)+1} OFFSET ${len(params)+2}
    """, *params, limit, offset)

    items = []
    for r in rows:
        d = dict(r)
        d["tags"] = parse_tags(d.get("tags"))
        if d.get("identities") and isinstance(d["identities"], str):
            d["identities"] = json.loads(d["identities"])
        # Берём первую идентичность для обратной совместимости с UI
        identities = d.get("identities") or []
        if identities:
            d["platform_user_id"] = identities[0].get("platform_user_id")
            d["username"] = identities[0].get("username")
            d["first_name"] = identities[0].get("first_name")
            d["last_name"] = identities[0].get("last_name")
        else:
            d["platform_user_id"] = None
            d["username"] = None
            d["first_name"] = None
            d["last_name"] = None
        items.append(d)

    return {
        "total": total,
        "total_all": total_all,
        "subscribed": subscribed,
        "unsubscribed": unsubscribed,
        "items": items,
    }


@router.get("/contacts/filter-options")
async def get_filter_options(
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Опции для окошка фильтра: список платформ, каналов, utm-источников и тегов
    клиента. Используется фронтом контактов для выпадашек."""
    client_id = int(client["sub"])

    platforms = await db.fetch("""
        SELECT p.slug, p.display_name, p.color_hex
          FROM platforms p
         WHERE p.is_active = TRUE
           AND EXISTS (
              SELECT 1 FROM platform_users pu
               WHERE pu.client_id = $1 AND pu.platform_slug = p.slug
           )
         ORDER BY p.sort_order, p.slug
    """, client_id)

    channels = await db.fetch("""
        SELECT ch.id, ch.platform_slug, ch.display_name, ch.handle, ch.is_active
          FROM channels ch
         WHERE ch.client_id = $1
         ORDER BY ch.platform_slug, ch.is_active DESC, ch.id
    """, client_id)

    utm_rows = await db.fetch("""
        SELECT DISTINCT utm_source
          FROM contacts
         WHERE client_id = $1 AND is_active = TRUE
           AND utm_source IS NOT NULL AND utm_source <> ''
         ORDER BY utm_source
    """, client_id)

    tag_rows = await db.fetch("""
        SELECT DISTINCT jsonb_array_elements_text(tags) AS tag
          FROM contacts
         WHERE client_id = $1 AND is_active = TRUE
           AND tags IS NOT NULL AND jsonb_typeof(tags) = 'array'
         ORDER BY tag
    """, client_id)

    return {
        "platforms": [dict(r) for r in platforms],
        "channels": [dict(r) for r in channels],
        "utm_sources": [r["utm_source"] for r in utm_rows],
        "tags": [r["tag"] for r in tag_rows if r["tag"]],
    }


@router.get("/contacts/{contact_id}")
async def get_contact(
    contact_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    """Карточка контакта: данные человека + идентичности с подписками на каналы."""
    client_id = int(client["sub"])

    row = await db.fetchrow("""
        SELECT
          c.id,
          c.name,
          c.email,
          c.phone,
          c.utm_source,
          c.tags,
          c.ref_code,
          c.salebot_id,
          c.last_contact_at,
          c.created_at,
          c.merged_into,
          c.merged_ref_codes,
          (SELECT json_build_object('id', ref.id, 'name', ref.name)
             FROM contacts ref
            WHERE ref.id = c.first_referrer_contact_id LIMIT 1) AS referrer
        FROM contacts c
        WHERE c.id = $1 AND c.client_id = $2
    """, contact_id, client_id)

    if not row:
        raise HTTPException(status_code=404, detail="Not found")

    # Идентичности с подписками на каналы (группируем по платформе)
    identities = await db.fetch("""
        SELECT
          pu.id,
          pu.platform_slug,
          pu.platform_user_id,
          pu.username,
          pu.first_name,
          pu.last_name,
          p.display_name AS platform_display_name,
          p.icon_url AS platform_icon_url,
          p.color_hex AS platform_color_hex,
          (SELECT json_agg(json_build_object(
              'channel_id', ch.id,
              'channel_name', ch.display_name,
              'channel_handle', ch.handle,
              'is_unsubscribed', puc.is_unsubscribed,
              'subscribed_at', puc.subscribed_at,
              'unsubscribed_at', puc.unsubscribed_at
            ) ORDER BY ch.id)
            FROM platform_user_channels puc
            JOIN channels ch ON ch.id = puc.channel_id
           WHERE puc.platform_user_id = pu.id) AS subscriptions
        FROM platform_users pu
        JOIN platforms p ON p.slug = pu.platform_slug
        WHERE pu.contact_id = $1
        ORDER BY p.sort_order, pu.id
    """, contact_id)

    identities_list = []
    for ident in identities:
        d = dict(ident)
        if d.get("subscriptions") and isinstance(d["subscriptions"], str):
            d["subscriptions"] = json.loads(d["subscriptions"])
        if d.get("subscriptions") is None:
            d["subscriptions"] = []
        identities_list.append(d)

    # События в которых участвует
    events = await db.fetch("""
        SELECT e.id, e.title, e.slug, ep.is_registered, ep.is_in_chat, ep.registered_at, c.ref_code,
               (SELECT COUNT(*) FROM event_participants ep2 WHERE ep2.referrer_ref_code = c.ref_code AND ep2.event_id = e.id) AS referrals_count
        FROM event_participants ep
        JOIN events e ON e.id = ep.event_id
        JOIN contacts c ON c.id = ep.contact_id
        WHERE ep.contact_id = $1
        ORDER BY ep.registered_at DESC NULLS LAST, e.id DESC
    """, contact_id)

    row_dict = dict(row)
    row_dict["tags"] = parse_tags(row_dict.get("tags"))
    if row_dict.get("merged_ref_codes") and isinstance(row_dict["merged_ref_codes"], str):
        row_dict["merged_ref_codes"] = json.loads(row_dict["merged_ref_codes"])

    # Для обратной совместимости с UI: первая идентичность как fallback
    if identities_list:
        first = identities_list[0]
        row_dict["platform_user_id"] = first.get("platform_user_id")
        row_dict["username"] = first.get("username")
        row_dict["first_name"] = first.get("first_name")
        row_dict["last_name"] = first.get("last_name")
    else:
        row_dict["platform_user_id"] = None
        row_dict["username"] = None
        row_dict["first_name"] = None
        row_dict["last_name"] = None

    return {
        **row_dict,
        "identities": identities_list,
        "events": [dict(e) for e in events],
    }


# ── Возможные дубли ───────────────────────────
@router.get("/contacts/{contact_id}/duplicates")
async def get_duplicates(
    contact_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db)
):
    """Возможные дубли — другие активные контакты клиента с совпадающим email/phone/именем."""
    client_id = int(client["sub"])
    target = await db.fetchrow(
        """SELECT id, client_id, name, email_normalized, phone_normalized
             FROM contacts WHERE id = $1 AND client_id = $2""",
        contact_id, client_id
    )
    if not target:
        raise HTTPException(status_code=404, detail="Not found")

    rows = await db.fetch(
        """SELECT c.id, c.name, c.email, c.phone, c.ref_code,
                  CASE
                    WHEN $3::TEXT IS NOT NULL AND c.email_normalized = $3 THEN 'email'
                    WHEN $4::TEXT IS NOT NULL AND c.phone_normalized = $4 THEN 'phone'
                    WHEN $5::TEXT IS NOT NULL AND c.name IS NOT NULL
                         AND LOWER(c.name) = LOWER($5) THEN 'name'
                    ELSE 'other'
                  END AS match_reason
             FROM contacts c
            WHERE c.client_id = $1 AND c.id <> $2 AND c.is_active = TRUE
              AND (
                ($3::TEXT IS NOT NULL AND c.email_normalized = $3)
                OR ($4::TEXT IS NOT NULL AND c.phone_normalized = $4)
                OR ($5::TEXT IS NOT NULL AND c.name IS NOT NULL AND LOWER(c.name) = LOWER($5))
              )
            ORDER BY match_reason, c.id
            LIMIT 20""",
        client_id, contact_id, target['email_normalized'], target['phone_normalized'], target['name']
    )
    return {"items": [dict(r) for r in rows]}


# ── Ручной мердж ──────────────────────────────
class MergeRequest(BaseModel):
    target_id: int  # secondary_id (главным остаётся текущий, secondary вливается в него)


@router.post("/contacts/{primary_id}/merge")
async def merge_endpoint(
    primary_id: int,
    payload: MergeRequest,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Объединяет два контакта в один. Главный — primary_id (URL), второстепенный — target_id (body)."""
    client_id = int(client["sub"])
    try:
        result = await merge_contacts(
            db, primary_id=primary_id, secondary_id=payload.target_id, client_id=client_id
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, **result}
