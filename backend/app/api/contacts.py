"""
API контактов (миграция 036+ — иерархия Контактов).

Источник истины — таблица `contacts`. Идентичности (`platform_users`)
JOIN'ятся для отображения username и подписок на каналы.
"""
import csv
import io
import json
from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import StreamingResponse
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


# SQL-фрагмент: контакт «отписан» — у него есть отписка и нет ни одной активной подписки
# в рамках клиента. Если подписок нет вообще — считаем подписанным.
UNSUB_EXISTS_SQL = """(EXISTS (
    SELECT 1 FROM platform_users pu
    JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
    JOIN client_channels cc ON cc.id = puc.client_channel_id
    WHERE pu.contact_id = c.id AND cc.client_id = c.client_id
      AND puc.is_unsubscribed = TRUE
) AND NOT EXISTS (
    SELECT 1 FROM platform_users pu
    JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
    JOIN client_channels cc ON cc.id = puc.client_channel_id
    WHERE pu.contact_id = c.id AND cc.client_id = c.client_id
      AND puc.is_unsubscribed = FALSE
))"""


def _build_contacts_filter(
    client_id: int,
    *,
    search: str = "",
    platforms: str | None = None,
    channel_ids: str | None = None,
    include_unattached: bool = False,
    utm_sources: str | None = None,
    tags: str | None = None,
    event_ids: str | None = None,
    lead_magnet_ids: str | None = None,
    package_ids: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
) -> tuple[str, list]:
    """Собирает WHERE-клозу и список параметров (без фильтра по subscription state).

    Возвращает (where_sql, params). where_sql начинается с 'WHERE'. Алиас
    основной таблицы — `c` (contacts c).
    """
    where = "WHERE c.client_id = $1 AND c.is_active = TRUE"
    params: list = [client_id]

    if search:
        params.append(f"%{search}%")
        idx = len(params)
        where += f"""
          AND (
            c.name ILIKE ${idx} OR c.email ILIKE ${idx} OR c.phone ILIKE ${idx}
            OR EXISTS (
                SELECT 1 FROM platform_users pu
                 WHERE pu.contact_id = c.id
                   AND (pu.username ILIKE ${idx} OR pu.first_name ILIKE ${idx} OR pu.last_name ILIKE ${idx})
            )
          )
        """

    platforms_list = _split_csv(platforms)
    if platforms_list:
        params.append(platforms_list)
        idx = len(params)
        where += f"""
          AND EXISTS (
            SELECT 1 FROM platform_users pu
             WHERE pu.contact_id = c.id AND pu.platform_slug = ANY(${idx}::text[])
          )
        """

    channel_ids_raw = _split_csv(channel_ids)
    channel_ids_int: list[int] = []
    for x in channel_ids_raw:
        try:
            channel_ids_int.append(int(x))
        except ValueError:
            pass
    explicit_empty = channel_ids is not None and not channel_ids_int

    no_subs_clause = """NOT EXISTS (
        SELECT 1 FROM platform_users pu
        JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
         WHERE pu.contact_id = c.id
    )"""

    if channel_ids_int and include_unattached:
        params.append(channel_ids_int)
        idx = len(params)
        where += f"""
          AND (
            EXISTS (
              SELECT 1 FROM platform_users pu
              JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
              JOIN client_channels cc ON cc.id = puc.client_channel_id
               WHERE pu.contact_id = c.id
                 AND cc.channel_id = ANY(${idx}::int[])
                 AND puc.is_unsubscribed = FALSE
            )
            OR {no_subs_clause}
          )
        """
    elif channel_ids_int:
        params.append(channel_ids_int)
        idx = len(params)
        where += f"""
          AND EXISTS (
            SELECT 1 FROM platform_users pu
            JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
            JOIN client_channels cc ON cc.id = puc.client_channel_id
             WHERE pu.contact_id = c.id
               AND cc.channel_id = ANY(${idx}::int[])
               AND puc.is_unsubscribed = FALSE
          )
        """
    elif explicit_empty and include_unattached:
        where += f" AND {no_subs_clause}"
    elif explicit_empty:
        where += " AND FALSE"
    elif include_unattached:
        where += f" AND {no_subs_clause}"

    utm_list = _split_csv(utm_sources)
    if utm_list:
        params.append(utm_list)
        idx = len(params)
        where += f" AND c.utm_source = ANY(${idx}::text[])"

    tags_list = _split_csv(tags)
    if tags_list:
        params.append(tags_list)
        idx = len(params)
        where += f" AND c.tags ?| ${idx}::text[]"

    def _ints(val):
        out = []
        for x in _split_csv(val):
            try:
                out.append(int(x))
            except ValueError:
                pass
        return out

    event_ids_int = _ints(event_ids)
    if event_ids_int:
        params.append(event_ids_int)
        idx = len(params)
        where += f"""
          AND EXISTS (
            SELECT 1 FROM event_participants ep
             WHERE ep.contact_id = c.id AND ep.event_id = ANY(${idx}::int[])
          )
        """

    lead_magnet_ids_int = _ints(lead_magnet_ids)
    if lead_magnet_ids_int:
        params.append(lead_magnet_ids_int)
        idx = len(params)
        where += f"""
          AND EXISTS (
            SELECT 1 FROM funnel_runs fr
             WHERE fr.contact_id = c.id AND fr.lead_magnet_id = ANY(${idx}::int[])
          )
        """

    package_ids_int = _ints(package_ids)
    if package_ids_int:
        params.append(package_ids_int)
        idx = len(params)
        where += f"""
          AND EXISTS (
            SELECT 1 FROM funnel_runs fr
             WHERE fr.contact_id = c.id AND fr.package_id = ANY(${idx}::int[])
          )
        """

    if date_from:
        params.append(date_from)
        idx = len(params)
        where += f" AND c.last_contact_at >= ${idx}::timestamptz"
    if date_to:
        params.append(date_to)
        idx = len(params)
        where += f" AND c.last_contact_at <= ${idx}::timestamptz"

    return where, params


def _apply_subscription_filter(where_base: str, subscription: str, show_unsubscribed: bool) -> str:
    """Дополняет WHERE-клозу фильтром по состоянию подписки."""
    sub_state = (subscription or "any").lower()
    if sub_state == "subscribed":
        return where_base + f" AND NOT {UNSUB_EXISTS_SQL}"
    if sub_state == "unsubscribed":
        return where_base + f" AND {UNSUB_EXISTS_SQL}"
    if not show_unsubscribed:
        return where_base + f" AND NOT {UNSUB_EXISTS_SQL}"
    return where_base


@router.get("/contacts")
async def get_contacts(
    search: str = Query(default="", alias="search"),
    limit: int = Query(default=50),
    offset: int = Query(default=0),
    show_unsubscribed: bool = Query(default=False),
    subscription: str = Query(default="any", description="any | subscribed | unsubscribed"),
    platforms: str | None = Query(default=None, description="CSV slug-ов платформ: telegram,vk"),
    channel_ids: str | None = Query(default=None, description="CSV id каналов клиента. Пустая строка '' = ни одного канала (0 результатов, если не выбрано include_unattached)"),
    include_unattached: bool = Query(default=False, description="Включить контакты без подписки ни на один канал (orphan'ы)"),
    utm_sources: str | None = Query(default=None, description="CSV utm_source значений"),
    tags: str | None = Query(default=None, description="CSV тегов (любой из них)"),
    event_ids: str | None = Query(default=None, description="CSV id событий — контакт был участником хотя бы одного из них"),
    lead_magnet_ids: str | None = Query(default=None, description="CSV id лид-магнитов — контакт зашёл по ссылке хотя бы одного из них"),
    package_ids: str | None = Query(default=None, description="CSV id пакетов — контакт зашёл по ссылке хотя бы одного из них"),
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

    where_base, params = _build_contacts_filter(
        client_id,
        search=search,
        platforms=platforms,
        channel_ids=channel_ids,
        include_unattached=include_unattached,
        utm_sources=utm_sources,
        tags=tags,
        event_ids=event_ids,
        lead_magnet_ids=lead_magnet_ids,
        package_ids=package_ids,
        date_from=date_from,
        date_to=date_to,
    )
    UNSUB_EXISTS = UNSUB_EXISTS_SQL
    where = _apply_subscription_filter(where_base, subscription, show_unsubscribed)

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


@router.get("/contacts/export")
async def export_contacts_csv(
    search: str = Query(default=""),
    show_unsubscribed: bool = Query(default=False),
    subscription: str = Query(default="any"),
    platforms: str | None = Query(default=None),
    channel_ids: str | None = Query(default=None),
    include_unattached: bool = Query(default=False),
    utm_sources: str | None = Query(default=None),
    tags: str | None = Query(default=None),
    event_ids: str | None = Query(default=None),
    lead_magnet_ids: str | None = Query(default=None),
    package_ids: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """CSV-экспорт контактов с теми же фильтрами, что у GET /contacts.

    Отдаёт UTF-8 файл с BOM (для корректного открытия в Excel) и нужным
    Content-Disposition. В каждой строке — основные поля контакта, его
    идентичности на платформах и активные/отписанные каналы подписки.
    """
    client_id = int(client["sub"])

    where_base, params = _build_contacts_filter(
        client_id,
        search=search,
        platforms=platforms,
        channel_ids=channel_ids,
        include_unattached=include_unattached,
        utm_sources=utm_sources,
        tags=tags,
        event_ids=event_ids,
        lead_magnet_ids=lead_magnet_ids,
        package_ids=package_ids,
        date_from=date_from,
        date_to=date_to,
    )
    where = _apply_subscription_filter(where_base, subscription, show_unsubscribed)

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
          (SELECT json_agg(json_build_object(
              'name', ch.display_name,
              'is_unsubscribed', puc.is_unsubscribed
            ))
            FROM platform_users pu
            JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
            JOIN client_channels cc ON cc.id = puc.client_channel_id
            JOIN channels ch ON ch.id = cc.channel_id
           WHERE pu.contact_id = c.id AND cc.client_id = c.client_id) AS subs
        FROM contacts c
        {where}
        ORDER BY c.name NULLS LAST, c.id
    """, *params)

    buf = io.StringIO()
    buf.write('﻿')  # BOM для Excel
    writer = csv.writer(buf, delimiter=';', quoting=csv.QUOTE_MINIMAL)
    writer.writerow([
        'ID', 'Имя', 'Email', 'Телефон', 'Реф-код', 'UTM-источник', 'Теги',
        'Telegram', 'VK', 'MAX',
        'Каналы (подписан)', 'Каналы (отписан)',
        'Откуда пришёл', 'Создан', 'Последний контакт',
    ])

    def _fmt_dt(v):
        if not v:
            return ''
        return v.strftime('%Y-%m-%d %H:%M') if hasattr(v, 'strftime') else str(v)[:16]

    for r in rows:
        identities = r['identities']
        if isinstance(identities, str):
            identities = json.loads(identities)
        identities = identities or []
        subs = r['subs']
        if isinstance(subs, str):
            subs = json.loads(subs)
        subs = subs or []
        tags_val = parse_tags(r['tags']) or []

        plat = {'telegram': [], 'vk': [], 'max': []}
        for ident in identities:
            slug = ident.get('platform_slug')
            if slug not in plat:
                continue
            uname = ident.get('username')
            puid = ident.get('platform_user_id')
            label = (f"@{uname} " if uname else '') + f"#{puid}" if puid else (uname or '')
            plat[slug].append(label)

        active_channels = '; '.join(s['name'] for s in subs if not s.get('is_unsubscribed'))
        unsub_channels = '; '.join(s['name'] for s in subs if s.get('is_unsubscribed'))

        writer.writerow([
            r['id'],
            r['name'] or '',
            r['email'] or '',
            r['phone'] or '',
            r['ref_code'] or '',
            r['utm_source'] or '',
            '; '.join(tags_val),
            '; '.join(plat['telegram']),
            '; '.join(plat['vk']),
            '; '.join(plat['max']),
            active_channels,
            unsub_channels,
            r['referrer_name'] or '',
            _fmt_dt(r['created_at']),
            _fmt_dt(r['last_contact_at']),
        ])

    csv_bytes = buf.getvalue().encode('utf-8')
    return StreamingResponse(
        iter([csv_bytes]),
        media_type='text/csv; charset=utf-8',
        headers={
            'Content-Disposition': 'attachment; filename="contacts.csv"',
            'Content-Length': str(len(csv_bytes)),
        },
    )


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

    # Архитектура G: каналы клиента через client_channels (его свои + системные).
    channels = await db.fetch("""
        SELECT ch.id, ch.platform_slug, ch.display_name, ch.handle, cc.is_active, ch.is_system
          FROM channels ch
          JOIN client_channels cc ON cc.channel_id = ch.id
         WHERE cc.client_id = $1
         ORDER BY ch.platform_slug, cc.is_active DESC, ch.id
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

    events = await db.fetch("""
        SELECT id, title, slug
          FROM events
         WHERE client_id = $1
         ORDER BY COALESCE(start_at, created_at) DESC NULLS LAST, id DESC
    """, client_id)

    lead_magnets = await db.fetch("""
        SELECT id, name
          FROM lead_magnets
         WHERE client_id = $1
         ORDER BY name
    """, client_id)

    packages = await db.fetch("""
        SELECT id, name
          FROM lead_magnet_packages
         WHERE client_id = $1
         ORDER BY name
    """, client_id)

    return {
        "platforms": [dict(r) for r in platforms],
        "channels": [dict(r) for r in channels],
        "utm_sources": [r["utm_source"] for r in utm_rows],
        "tags": [r["tag"] for r in tag_rows if r["tag"]],
        "events": [dict(r) for r in events],
        "lead_magnets": [dict(r) for r in lead_magnets],
        "packages": [dict(r) for r in packages],
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
            JOIN client_channels cc ON cc.id = puc.client_channel_id
            JOIN channels ch ON ch.id = cc.channel_id
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

    # Воронки лид-магнитов (история интереса)
    lead_magnet_runs = await db.fetch("""
        SELECT
          fr.id, fr.stage, fr.utm,
          fr.landed_at, fr.started_at, fr.subscribed_at, fr.delivered_at,
          fr.text3_sent_at, fr.text3_kind,
          fr.lead_magnet_id, fr.package_id,
          COALESCE(lm.name, pkg.name) AS source_name,
          CASE WHEN fr.lead_magnet_id IS NOT NULL THEN 'magnet' ELSE 'package' END AS source_kind,
          CASE WHEN fr.lead_magnet_id IS NOT NULL THEN lm.slug ELSE pkg.slug END AS source_slug
        FROM funnel_runs fr
        LEFT JOIN lead_magnets lm ON lm.id = fr.lead_magnet_id
        LEFT JOIN lead_magnet_packages pkg ON pkg.id = fr.package_id
        WHERE fr.contact_id = $1
        ORDER BY fr.landed_at DESC
        LIMIT 100
    """, contact_id)
    lead_magnet_runs_list = []
    for r in lead_magnet_runs:
        d = dict(r)
        if isinstance(d.get("utm"), str):
            try:
                d["utm"] = json.loads(d["utm"])
            except Exception:
                d["utm"] = {}
        lead_magnet_runs_list.append(d)

    # Если этот контакт — также коллаборатор, отдадим краткую инфу
    collaborator_row = await db.fetchrow(
        """SELECT id, name, title, photo_url
             FROM collaborators
            WHERE contact_id = $1 AND created_by_client_id = $2
            LIMIT 1""",
        contact_id, client_id
    )

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
        "lead_magnet_runs": lead_magnet_runs_list,
        "collaborator": dict(collaborator_row) if collaborator_row else None,
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


# ─── Редактирование контакта (имя, email, phone, tags) ───────────────────────

class ContactUpdateRequest(BaseModel):
    name:  Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None


@router.patch("/contacts/{contact_id}")
async def update_contact(
    contact_id: int,
    data: ContactUpdateRequest,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Обновить имя/email/phone контакта. Только своих контактов."""
    client_id = int(client["sub"])
    own = await db.fetchval(
        "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
        contact_id, client_id
    )
    if not own:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    sets = []
    args: list = []
    if data.name is not None:
        name = (data.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Имя не может быть пустым")
        if len(name) > 200:
            raise HTTPException(status_code=400, detail="Имя слишком длинное (>200 симв.)")
        args.append(name)
        sets.append(f"name = ${len(args)}")
    if data.email is not None:
        from app.services.contact_merge import normalize_email as _normalize_email
        em = (data.email or "").strip() or None
        args.append(em); sets.append(f"email = ${len(args)}")
        args.append(_normalize_email(em) if em else None); sets.append(f"email_normalized = ${len(args)}")
    if data.phone is not None:
        from app.services.contact_merge import normalize_phone as _normalize_phone
        ph = (data.phone or "").strip() or None
        args.append(ph); sets.append(f"phone = ${len(args)}")
        args.append(_normalize_phone(ph) if ph else None); sets.append(f"phone_normalized = ${len(args)}")

    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    args.append(contact_id)
    row = await db.fetchrow(
        f"UPDATE contacts SET {', '.join(sets)}, updated_at = NOW() "
        f"WHERE id = ${len(args)} RETURNING id, name, email, phone",
        *args
    )
    return {"ok": True, "contact": dict(row)}


@router.delete("/contacts/{contact_id}")
async def delete_contact(
    contact_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Полное удаление контакта со всеми связанными данными.

    Каскадно подтянет:
    - platform_users (идентичности в TG/VK/MAX)
    - event_participants (участия в событиях + gift_issuances, raffle_tickets через FK)
    - funnel_runs (прохождения воронок лид-магнитов)
    - referrer_* ссылки у других участников/контактов → NULL

    БЛОКИРУЕТСЯ если контакт привязан к коллаборатору — сначала надо
    удалить коллаборацию (в /dashboard/collaborations), потом контакт.
    Сделано чтобы клиент не убил случайно спикера/соорганизатора одной кнопкой.
    """
    client_id = int(client["sub"])

    own = await db.fetchval(
        "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
        contact_id, client_id
    )
    if not own:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    # Если этот контакт — коллаборатор (спикер/соорганизатор), блокируем
    # удаление с понятным русским сообщением. У collaborators нет
    # client_id — привязка к клиенту идёт через contact_id → contacts.client_id,
    # а контракт «не чужой контакт» мы уже проверили выше.
    collab = await db.fetchval(
        "SELECT id FROM collaborators WHERE contact_id = $1 LIMIT 1",
        contact_id,
    )
    if collab:
        raise HTTPException(
            status_code=409,
            detail=(
                "Контакт связан с коллаборатором (спикер/соорганизатор). "
                "Сначала удалите коллаборацию в разделе «Коллаборации» — "
                "после этого можно будет удалить контакт."
            ),
        )

    await db.execute("DELETE FROM contacts WHERE id = $1", contact_id)
    return {"ok": True}
