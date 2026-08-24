"""
API контактов (миграция 036+ — иерархия Контактов).

Источник истины — таблица `contacts`. Идентичности (`platform_users`)
JOIN'ятся для отображения username и подписок на каналы.
"""
import csv
import io
import json
from typing import Optional
from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from app.auth import get_current_client
from app.database import get_db
from app.services.assistant_access import assistant_is_restricted
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
    lead_magnet_stage: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    created_from: str | None = None,
    created_to: str | None = None,
    blacklisted: str | None = None,
    field_filter: str | None = None,
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
            c.name ILIKE ${idx} OR c.phone ILIKE ${idx}
            OR c.ref_code ILIKE ${idx}
            OR c.external_ref_param ILIKE ${idx}
            OR EXISTS (
                SELECT 1 FROM platform_users pu
                 WHERE pu.contact_id = c.id
                   AND (pu.username ILIKE ${idx} OR pu.first_name ILIKE ${idx}
                        OR pu.last_name ILIKE ${idx} OR pu.platform_user_id ILIKE ${idx})
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

    # Фильтр по дополнительному полю контакта (миграция 280).
    # Формат: "field_id:значение" — например "3:Свыше 1 000 000".
    # Пустое значение после двоеточия = «поле заполнено чем угодно».
    if field_filter and ':' in field_filter:
        f_id_raw, _, f_val = field_filter.partition(':')
        try:
            f_id = int(f_id_raw)
        except ValueError:
            f_id = None
        if f_id:
            params.append(f_id)
            idx_f = len(params)
            if f_val.strip():
                params.append(f_val.strip())
                idx_v = len(params)
                where += f"""
                  AND EXISTS (
                    SELECT 1 FROM contact_field_values v
                     WHERE v.contact_id = c.id AND v.field_id = ${idx_f}
                       AND v.value = ${idx_v}
                  )
                """
            else:
                where += f"""
                  AND EXISTS (
                    SELECT 1 FROM contact_field_values v
                     WHERE v.contact_id = c.id AND v.field_id = ${idx_f}
                       AND COALESCE(v.value,'') <> ''
                  )
                """

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

    # Стадия по выбранному лид-магниту/пакету (только если он выбран):
    #   'delivered'     — забрал материалы (есть run со stage='delivered')
    #   'not_delivered' — заходил по ссылке, но материалы так и не получил
    #   иначе (any/None) — все, кто вообще заходил
    stage_mode = (lead_magnet_stage or "any").strip().lower()
    if stage_mode not in ("delivered", "not_delivered"):
        stage_mode = "any"

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
        if stage_mode == "delivered":
            where += f"""
              AND EXISTS (
                SELECT 1 FROM funnel_runs fr
                 WHERE fr.contact_id = c.id AND fr.lead_magnet_id = ANY(${idx}::int[])
                   AND fr.stage = 'delivered'
              )
            """
        elif stage_mode == "not_delivered":
            where += f"""
              AND NOT EXISTS (
                SELECT 1 FROM funnel_runs fr
                 WHERE fr.contact_id = c.id AND fr.lead_magnet_id = ANY(${idx}::int[])
                   AND fr.stage = 'delivered'
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
        if stage_mode == "delivered":
            where += f"""
              AND EXISTS (
                SELECT 1 FROM funnel_runs fr
                 WHERE fr.contact_id = c.id AND fr.package_id = ANY(${idx}::int[])
                   AND fr.stage = 'delivered'
              )
            """
        elif stage_mode == "not_delivered":
            where += f"""
              AND NOT EXISTS (
                SELECT 1 FROM funnel_runs fr
                 WHERE fr.contact_id = c.id AND fr.package_id = ANY(${idx}::int[])
                   AND fr.stage = 'delivered'
              )
            """

    # ⚠️ Даты передаём СТРОКОЙ в текстовом параметре и приводим типом в SQL.
    # asyncpg отвергает str для ::timestamptz («expected a datetime.date
    # instance, got str») — фильтр падал 500, а во фронте это выглядело как
    # «фильтр не работает»: список оставался прежним.
    if date_from:
        params.append(str(date_from))
        idx = len(params)
        where += f" AND c.last_contact_at >= (${idx}::text)::timestamptz"
    if date_to:
        params.append(str(date_to))
        idx = len(params)
        where += f" AND c.last_contact_at <= (${idx}::text)::timestamptz"

    # ⚠️ Дата ПОПАДАНИЯ В БАЗУ — отдельный фильтр, не путать с «последним
    # контактом». «Последний контакт» отвечает на вопрос «когда человек в
    # последний раз о себе напомнил», а этот — «когда он у нас появился».
    # Второе нужно, чтобы отделить новых людей от тех, кто был в базе давно.
    if created_from:
        params.append(str(created_from))
        idx = len(params)
        where += f" AND c.created_at >= (${idx}::text)::timestamptz"
    if created_to:
        params.append(str(created_to))
        idx = len(params)
        # Конец дня, а не полночь: иначе «по 05.08» теряет весь день 5 августа.
        where += f" AND c.created_at < ((${idx}::text)::date + INTERVAL '1 day')"

    # Чёрный список (миграция 228): 'yes' — только заблокированные,
    # 'no' — только не заблокированные, пусто — фильтр не применяется.
    bl_mode = (blacklisted or "").strip().lower()
    if bl_mode in ("yes", "no"):
        bl_exists = """EXISTS (
            SELECT 1 FROM contact_blacklist bl
             WHERE bl.contact_id = c.id AND bl.client_id = c.client_id
        )"""
        where += f" AND {bl_exists}" if bl_mode == "yes" else f" AND NOT {bl_exists}"

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
    lead_magnet_stage: str | None = Query(default=None, description="any | delivered (забрал) | not_delivered (не забрал). Работает вместе с lead_magnet_ids/package_ids"),
    date_from: str | None = Query(default=None, description="ISO дата >= last_contact_at"),
    date_to: str | None = Query(default=None, description="ISO дата <= last_contact_at"),
    created_from: str | None = Query(default=None, description="ISO дата >= created_at (когда попал в базу)"),
    created_to: str | None = Query(default=None, description="ISO дата <= created_at (когда попал в базу)"),
    blacklisted: str | None = Query(default=None, description="yes — только в чёрном списке, no — только не в нём, пусто — все"),
    field_filter: str | None = Query(default=None, description="Доп. поле контакта: 'field_id:значение'"),
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
        lead_magnet_stage=lead_magnet_stage,
        date_from=date_from, created_from=created_from, created_to=created_to,
        date_to=date_to,
        blacklisted=blacklisted,
        field_filter=field_filter,
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
          (SELECT pe.platform_user_id FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1) AS email,
          -- Почтовик вернул отказ по этому адресу: писать на него бесполезно.
          -- Показываем клиенту в списке и в карточке контакта.
          COALESCE((SELECT pe.email_is_dead FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1), FALSE) AS email_is_dead,
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
          ) AS is_participant,
          EXISTS (
            SELECT 1 FROM contact_blacklist bl
             WHERE bl.contact_id = c.id AND bl.client_id = c.client_id
          ) AS is_blacklisted
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
    lead_magnet_stage: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    created_from: str | None = Query(default=None),
    created_to: str | None = Query(default=None),
    blacklisted: str | None = Query(default=None),
    field_filter: str | None = Query(default=None),
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
        lead_magnet_stage=lead_magnet_stage,
        date_from=date_from, created_from=created_from, created_to=created_to,
        date_to=date_to,
        blacklisted=blacklisted,
        field_filter=field_filter,
    )
    where = _apply_subscription_filter(where_base, subscription, show_unsubscribed)

    rows = await db.fetch(f"""
        SELECT
          c.id,
          c.name,
          (SELECT pe.platform_user_id FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1) AS email,
          -- Почтовик вернул отказ по этому адресу: писать на него бесполезно.
          -- Показываем клиенту в списке и в карточке контакта.
          COALESCE((SELECT pe.email_is_dead FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1), FALSE) AS email_is_dead,
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
           WHERE pu.contact_id = c.id AND cc.client_id = c.client_id) AS subs,
          EXISTS (
            SELECT 1 FROM contact_blacklist bl
             WHERE bl.contact_id = c.id AND bl.client_id = c.client_id
          ) AS is_blacklisted
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
        'Откуда пришёл', 'Создан', 'Последний контакт', 'Чёрный список',
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
            'да' if r['is_blacklisted'] else '',
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
               JOIN contacts c_own ON c_own.id = pu.contact_id
               WHERE c_own.client_id = $1 AND pu.platform_slug = p.slug
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
         WHERE id IN (SELECT event_id FROM event_owners WHERE client_id = $1 AND status = 'accepted')
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
          (SELECT pe.platform_user_id FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1) AS email,
          -- Почтовик вернул отказ по этому адресу: писать на него бесполезно.
          -- Показываем клиенту в списке и в карточке контакта.
          COALESCE((SELECT pe.email_is_dead FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1), FALSE) AS email_is_dead,
          (SELECT pe.email_dead_reason FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1) AS email_dead_reason,
          (SELECT pe.email_dead_at FROM platform_users pe
            WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
            ORDER BY pe.id LIMIT 1) AS email_dead_at,
          c.phone,
          c.utm_source,
          c.tags,
          c.ref_code,
          c.external_ref_param,
          c.linked_client_id,
          (SELECT lc.email FROM clients lc WHERE lc.id = c.linked_client_id) AS linked_client_email,
          c.is_staff,
          c.salebot_id,
          c.last_contact_at,
          c.created_at,
          c.merged_into,
          c.merged_ref_codes,
          c.consent_pd_at,
          c.consent_pd_ip,
          c.consent_pd_policy_ver,
          c.consent_marketing_at,
          c.consent_marketing_ip,
          c.consent_marketing_policy_ver,
          COALESCE(c.was_in_webinar, FALSE) AS was_in_webinar,
          (SELECT json_build_object('id', ref.id, 'name', ref.name)
             FROM contacts ref
            WHERE ref.id = c.first_referrer_contact_id LIMIT 1) AS referrer,
          EXISTS (
            SELECT 1 FROM contact_blacklist bl
             WHERE bl.contact_id = c.id AND bl.client_id = c.client_id
          ) AS is_blacklisted
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

    # История вебинаров: где контакт реально присутствовал в эфире
    # (webinar_presence, heartbeat раз в минуту → кол-во bucket'ов ≈ минуты).
    # Группируем по комнате дня (событие + день). registered — был ли в списке
    # зарегистрированных (webinar_registrations), а присутствие — по presence.
    webinar_history = await db.fetch("""
        SELECT wr.id AS room_id, wr.day_number,
               e.id AS event_id, e.title AS event_title, e.slug AS event_slug,
               (SELECT day_date FROM conf_days cd
                 WHERE cd.event_id = e.id AND cd.day_number = wr.day_number LIMIT 1) AS day_date,
               COUNT(DISTINCT p.bucket_at) AS minutes,
               MIN(p.bucket_at) AS first_seen_at,
               MAX(p.bucket_at) AS last_seen_at,
               EXISTS (SELECT 1 FROM webinar_registrations reg
                        WHERE reg.room_id = wr.id AND reg.contact_id = $1) AS registered
          FROM webinar_presence p
          JOIN webinar_rooms wr ON wr.id = p.room_id
          JOIN events e ON e.id = wr.event_id
         WHERE p.contact_id = $1
         GROUP BY wr.id, wr.day_number, e.id, e.title, e.slug
         ORDER BY MAX(p.bucket_at) DESC
         LIMIT 100
    """, contact_id)

    # Дополнительные поля контакта (миграция 280): «Доход», «Ниша», «Статус».
    # ⚠️ Отдаём ВСЕ поля клиента, а не только заполненные — иначе клиент не
    # увидит, что поле вообще существует, и не сможет вписать значение.
    custom_fields = await db.fetch(
        """SELECT f.id, f.title, f.kind, f.options, f.scale_min, f.scale_max,
                  v.value, v.updated_at
             FROM contact_fields f
             LEFT JOIN contact_field_values v
                    ON v.field_id = f.id AND v.contact_id = $1
            WHERE f.client_id = $2 AND f.is_active = TRUE AND f.show_in_card = TRUE
            ORDER BY f.sort_order, f.id""",
        contact_id, client_id)

    # Какие анкеты человек заполнял и что отвечал.
    survey_history = await db.fetch(
        """SELECT r.id, r.created_at, r.platform_slug,
                  s.id AS survey_id, s.title AS survey_title,
                  COALESCE(json_agg(json_build_object(
                      'question', q.title, 'value', a.value
                  ) ORDER BY q.sort_order, q.id)
                    FILTER (WHERE a.id IS NOT NULL), '[]') AS answers
             FROM survey_responses r
             JOIN surveys s ON s.id = r.survey_id
             LEFT JOIN survey_answers a ON a.response_id = r.id
             LEFT JOIN survey_questions q ON q.id = a.question_id
            WHERE r.contact_id = $1
            GROUP BY r.id, s.id
            ORDER BY r.created_at DESC
            LIMIT 50""",
        contact_id)

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

    # Причина «битого» адреса лежит в БД сырым ответом почтовика
    # («hard_bounce: host gmail-smtp-in… said: 550-5.1.1 …») — клиенту такое
    # показывать нельзя. Переводим той же функцией, что и в отчёте по рассылке,
    # чтобы формулировки в карточке и в рассылке совпадали.
    if row_dict.get("email_is_dead"):
        raw = row_dict.get("email_dead_reason") or ""
        if raw == "multiple_soft_bounces":
            row_dict["email_dead_reason"] = (
                "Почтовый сервис несколько раз подряд не принял письмо"
            )
        else:
            from app.tasks.email_bounce import human_reason
            row_dict["email_dead_reason"] = human_reason(
                None, raw, row_dict.get("email")
            )

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
        "webinar_history": [dict(w) for w in webinar_history],
        # ⚠️ options разворачиваем: asyncpg отдаёт JSONB строкой, и список
        # выбора в карточке контакта оказывался пустым.
        "custom_fields": [
            {**dict(f), "options": parse_tags(f["options"]) or []}
            for f in custom_fields
        ],
        # ⚠️ json_agg приходит строкой — разворачиваем, иначе список ответов
        # в карточке не отрисуется.
        "survey_history": [
            {**dict(r), "answers": parse_tags(r["answers"]) or []}
            for r in survey_history
        ],
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
    # email берём из email-идентичности (platform_users), не из contacts.email
    target = await db.fetchrow(
        """SELECT c.id, c.client_id, c.name, c.phone_normalized,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email_normalized
             FROM contacts c WHERE c.id = $1 AND c.client_id = $2""",
        contact_id, client_id
    )
    if not target:
        raise HTTPException(status_code=404, detail="Not found")

    rows = await db.fetch(
        """SELECT c.id, c.name,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email,
                  c.phone, c.ref_code,
                  CASE
                    WHEN $3::TEXT IS NOT NULL AND EXISTS (
                       SELECT 1 FROM platform_users pe WHERE pe.contact_id = c.id
                        AND pe.platform_slug = 'email' AND pe.platform_user_id = $3) THEN 'email'
                    WHEN $4::TEXT IS NOT NULL AND c.phone_normalized = $4 THEN 'phone'
                    WHEN $5::TEXT IS NOT NULL AND c.name IS NOT NULL
                         AND LOWER(c.name) = LOWER($5) THEN 'name'
                    ELSE 'other'
                  END AS match_reason
             FROM contacts c
            WHERE c.client_id = $1 AND c.id <> $2 AND c.is_active = TRUE
              AND (
                ($3::TEXT IS NOT NULL AND EXISTS (
                   SELECT 1 FROM platform_users pe WHERE pe.contact_id = c.id
                    AND pe.platform_slug = 'email' AND pe.platform_user_id = $3))
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


# ─── Чёрный список (миграция 228) ────────────────────────────────────────────

class BlacklistRequest(BaseModel):
    # Причина блокировки — для себя, показывается в карточке контакта.
    reason: Optional[str] = None


async def _assert_own_contact(db, contact_id: int, client_id: int) -> None:
    """Контакт должен принадлежать этому клиенту, иначе 404."""
    own = await db.fetchval(
        "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
        contact_id, client_id
    )
    if not own:
        raise HTTPException(status_code=404, detail="Контакт не найден")


@router.post("/contacts/{contact_id}/blacklist")
async def add_to_blacklist(
    contact_id: int,
    data: BlacklistRequest,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Добавить контакт в чёрный список кабинета.

    Заблокированный не получает контент из ботов этого клиента: бот отвечает
    заглушкой с каналами поддержки, рассылки не уходят, воронки не запускаются.
    В базах других клиентов тот же человек работает как обычно.
    """
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Управлять чёрным списком может только владелец кабинета.")
    client_id = int(client["sub"])
    await _assert_own_contact(db, contact_id, client_id)

    reason = (data.reason or "").strip() or None
    await db.execute(
        """INSERT INTO contact_blacklist (client_id, contact_id, reason, added_by)
           VALUES ($1, $2, $3, 'client')
           ON CONFLICT (client_id, contact_id) DO NOTHING""",
        client_id, contact_id, reason
    )
    return {"ok": True}


@router.delete("/contacts/{contact_id}/blacklist")
async def remove_from_blacklist(
    contact_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Убрать контакт из чёрного списка кабинета."""
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Управлять чёрным списком может только владелец кабинета.")
    client_id = int(client["sub"])
    await _assert_own_contact(db, contact_id, client_id)

    await db.execute(
        "DELETE FROM contact_blacklist WHERE client_id = $1 AND contact_id = $2",
        client_id, contact_id
    )
    return {"ok": True}


# ─── Редактирование контакта (имя, email, phone, tags) ───────────────────────

class ContactUpdateRequest(BaseModel):
    name:  Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    # Партнёрский параметр во внешней платформе клиента (GetCourse, Bizon360 и т.п.).
    # Опаковая строка "key=value" (например "gcpc=fdd97"). Пустая строка = очистить.
    external_ref_param: Optional[str] = None
    # Сотрудник/лидген: исключается из турнирной таблицы; в отчёте рефоводов
    # его трафик уходит в группу «Организатор».
    is_staff: Optional[bool] = None


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
    if data.phone is not None:
        from app.services.contact_merge import normalize_phone as _normalize_phone
        ph = (data.phone or "").strip() or None
        args.append(ph); sets.append(f"phone = ${len(args)}")
        args.append(_normalize_phone(ph) if ph else None); sets.append(f"phone_normalized = ${len(args)}")
    if data.external_ref_param is not None:
        erp = (data.external_ref_param or "").strip() or None
        if erp and len(erp) > 500:
            raise HTTPException(status_code=400, detail="Партнёрский параметр слишком длинный (>500 симв.)")
        args.append(erp); sets.append(f"external_ref_param = ${len(args)}")
    if data.is_staff is not None:
        args.append(bool(data.is_staff)); sets.append(f"is_staff = ${len(args)}")

    # email НЕ пишем в contacts — он живёт как идентичность (platform_users).
    email_change = data.email is not None
    em = ((data.email or "").strip() or None) if email_change else None

    if not sets and not email_change:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    if sets:
        args.append(contact_id)
        await db.execute(
            f"UPDATE contacts SET {', '.join(sets)}, updated_at = NOW() WHERE id = ${len(args)}",
            *args
        )

    if email_change:
        from app.services.contact_merge import (
            sync_email_identity_and_subscription,
            normalize_email as _normalize_email,
        )
        em_norm = _normalize_email(em)
        if em_norm:
            nm = await db.fetchval("SELECT name FROM contacts WHERE id = $1", contact_id)
            await sync_email_identity_and_subscription(
                db, client_id=client_id, contact_id=contact_id,
                email=em_norm, first_name=nm,
            )
        else:
            # email очищен — удаляем email-идентичность (подписки уйдут каскадом)
            await db.execute(
                "DELETE FROM platform_users WHERE contact_id = $1 AND platform_slug = 'email'",
                contact_id,
            )

    # Ответ: email берём из актуальной email-идентичности
    row = await db.fetchrow(
        """SELECT c.id, c.name, c.phone, c.external_ref_param,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                    ORDER BY pe.id LIMIT 1) AS email
             FROM contacts c WHERE c.id = $1""",
        contact_id,
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

    # Карточка основателя (self_collaborator, миграция 141) — удалять нельзя:
    # это собственная карточка клиента, добавляемая организатором в события.
    is_self = await db.fetchval(
        """SELECT 1 FROM clients cl
            JOIN collaborators co ON co.id = cl.self_collaborator_id
           WHERE cl.id = $1 AND co.contact_id = $2""",
        client_id, contact_id,
    )
    if is_self:
        raise HTTPException(
            status_code=409,
            detail=(
                "Это ваша карточка организатора — её нельзя удалить. "
                "Она используется как карточка в событиях и Коллабораторной."
            ),
        )

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


# ─── 152-ФЗ: экспорт и удаление персональных данных ──────────────────────


class ContactFieldValueIn(BaseModel):
    field_id: int
    value: Optional[str] = None


@router.put("/contacts/{contact_id}/fields")
async def set_contact_field_value(
    contact_id: int, data: ContactFieldValueIn,
    client=Depends(get_current_client), db=Depends(get_db),
):
    """Проставить значение дополнительного поля вручную в карточке контакта.

    ⚠️ Пустое значение = очистка (строка удаляется, а не хранится пустой):
    иначе «заполнено у N человек» считало бы пустышки.
    """
    client_id = int(client["sub"])
    own = await db.fetchval(
        """SELECT 1 FROM contacts c
             JOIN contact_fields f ON f.id = $3 AND f.client_id = c.client_id
            WHERE c.id = $1 AND c.client_id = $2""",
        contact_id, client_id, data.field_id)
    if not own:
        raise HTTPException(404, "Контакт или поле не найдены")

    val = (data.value or "").strip()
    if not val:
        await db.execute(
            "DELETE FROM contact_field_values WHERE contact_id=$1 AND field_id=$2",
            contact_id, data.field_id)
        return {"ok": True, "value": None}

    await db.execute(
        """INSERT INTO contact_field_values (contact_id, field_id, value, value_json, updated_at)
           VALUES ($1,$2,$3,$4::jsonb,NOW())
           ON CONFLICT (contact_id, field_id)
           DO UPDATE SET value = EXCLUDED.value,
                         value_json = EXCLUDED.value_json,
                         updated_at = NOW()""",
        contact_id, data.field_id, val, json.dumps(val))
    return {"ok": True, "value": val}


@router.post("/contacts/import")
async def import_contacts_csv(
    file: UploadFile = File(...),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """
    Импорт CSV контактов БЕЗ привязки к каналу (Этап 4).
    Колонки: name, email, phone, telegram_username (любые опционально, регистр любой).
    Разделитель — авто (запятая, точка с запятой, табуляция).

    ⚠️ Файл БЕЗ строки-заголовка поддержан: голый список почт/телефонов —
    самый частый формат выгрузки у клиентов. Если первая строка сама похожа
    на данные (почта/телефон), заголовка нет — колонку определяем по содержимому,
    и первая строка НЕ теряется. Раньше она молча съедалась как «название колонки»,
    остальные строки не распознавались, и импорт возвращал 0 без объяснения.

    Логика:
    - Каждая строка → find_or_create_contact (автомердж по email/phone)
    - Если совпало только по одному полю (e.g. тот же email, но другой phone)
      — создаём новый контакт + помечаем строкой в conflicts отчёте
    - Возвращает {created, merged, conflicts, skipped, rows_total, ...}
    """
    import csv as _csv
    import io as _io
    from app.services.contact_merge import (
        find_or_create_contact, normalize_email, normalize_phone,
    )
    if (file.content_type or "") and "csv" not in file.content_type and "text" not in file.content_type:
        raise HTTPException(status_code=400, detail="Ожидается CSV-файл")
    raw = await file.read()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Файл больше 10 МБ")

    # Кодировка: пробуем utf-8, fallback на cp1251
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise HTTPException(status_code=400, detail="Не удалось определить кодировку")

    # Auto-detect разделитель
    sniffer = _csv.Sniffer()
    try:
        dialect = sniffer.sniff(text[:2048], delimiters=",;\t")
    except _csv.Error:
        dialect = _csv.excel

    rows_raw = list(_csv.reader(_io.StringIO(text), dialect=dialect))
    rows_raw = [r for r in rows_raw if any((c or "").strip() for c in r)]
    if not rows_raw:
        raise HTTPException(status_code=400, detail="Файл пустой — в нём нет ни одной строки с данными.")

    header = [(h or "").strip() for h in rows_raw[0]]

    # Алиасы колонок
    cols = {h.lower(): idx for idx, h in enumerate(header)}
    def pick(*names):
        for n in names:
            if n in cols:
                return cols[n]
        return None

    idx_name  = pick("name", "имя", "фио", "full_name")
    idx_email = pick("email", "e-mail", "почта", "емейл", "емаил", "mail")
    idx_phone = pick("phone", "телефон", "tel", "тел")
    idx_tg    = pick("telegram_username", "telegram", "tg", "username", "никнейм")

    # ⚠️ Файл БЕЗ заголовка (голый список почт/телефонов) — самый частый формат
    # выгрузки. Раньше первая строка съедалась как «название колонки», остальные
    # не распознавались, и импорт возвращал 0 без единого объяснения.
    has_header = any(x is not None for x in (idx_name, idx_email, idx_phone, idx_tg))
    data_rows = rows_raw[1:] if has_header else rows_raw
    first_row_offset = 2 if has_header else 1

    if not has_header:
        # Определяем колонку по СОДЕРЖИМОМУ первой строки.
        for idx, cell in enumerate(header):
            if "@" in cell:
                idx_email = idx
                break
        if idx_email is None:
            for idx, cell in enumerate(header):
                if sum(ch.isdigit() for ch in cell) >= 10:
                    idx_phone = idx
                    break
        if idx_email is None and idx_phone is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Не удалось понять, что в файле. Ожидались почты или телефоны, "
                    "но в первой строке их нет. Либо добавьте первой строкой название "
                    "колонки — email, phone, name или telegram_username, — либо "
                    "загрузите файл, где в каждой строке одна почта."
                ),
            )
        # Одна колонка данных — если рядом есть ещё, вторую считаем именем.
        if len(header) > 1 and idx_name is None:
            for idx in range(len(header)):
                if idx not in (idx_email, idx_phone) and (header[idx] or "").strip():
                    idx_name = idx
                    break

    # Колонки, которые есть в файле, но мы не поняли, что в них лежит.
    # Клиент должен видеть их поимённо, а не гадать, почему импортировано 0.
    used_idx = {x for x in (idx_name, idx_email, idx_phone, idx_tg) if x is not None}
    unknown_columns = [
        {"column": header[idx] or f"колонка {idx + 1}", "position": idx + 1}
        for idx in range(len(header))
        if idx not in used_idx and (header[idx] or "").strip()
    ] if has_header else []

    recognized = {
        "name": header[idx_name] if has_header and idx_name is not None else None,
        "email": header[idx_email] if has_header and idx_email is not None else None,
        "phone": header[idx_phone] if has_header and idx_phone is not None else None,
        "telegram_username": header[idx_tg] if has_header and idx_tg is not None else None,
    }

    client_id = int(client["sub"])
    stats = {
        "created": 0, "merged": 0, "conflicts": [],
        "rows_total": len(data_rows), "skipped_empty": 0,
        "invalid_emails": [], "has_header": has_header,
        "unknown_columns": unknown_columns, "recognized": recognized,
    }

    def cell(row: list, idx) -> Optional[str]:
        if idx is None or idx >= len(row):
            return None
        return (row[idx] or "").strip() or None

    for i, row in enumerate(data_rows, start=first_row_offset):
        name = cell(row, idx_name)
        email = cell(row, idx_email)
        phone = cell(row, idx_phone)
        tg_username = (cell(row, idx_tg) or "").lstrip("@") or None

        # Явная опечатка в почте — не заводим мусор молча, показываем клиенту.
        if email and ("@" not in email or "." not in email.split("@")[-1] or " " in email):
            if len(stats["invalid_emails"]) < 50:
                stats["invalid_emails"].append({"row": i, "value": email})
            continue

        if not (email or phone or tg_username):
            stats["skipped_empty"] += 1
            continue

        email_n = normalize_email(email)
        phone_n = normalize_phone(phone)

        # Конфликтная ситуация: email совпал с одним контактом, phone — с другим
        if email_n and phone_n:
            by_email = await db.fetchval(
                """SELECT pe.contact_id FROM platform_users pe
                     JOIN contacts c ON c.id = pe.contact_id AND c.is_active = TRUE
                    WHERE pe.client_id=$1 AND pe.platform_slug='email'
                      AND pe.platform_user_id=$2 LIMIT 1""",
                client_id, email_n,
            )
            by_phone = await db.fetchval(
                "SELECT id FROM contacts WHERE client_id=$1 AND phone_normalized=$2 AND is_active=TRUE LIMIT 1",
                client_id, phone_n,
            )
            if by_email and by_phone and by_email != by_phone:
                # Конфликт — создаём новый, но фиксируем
                contact_id, _is_new = await find_or_create_contact(
                    db, client_id=client_id, name=name, email=email, phone=phone,
                )
                stats["conflicts"].append({
                    "row": i, "csv_name": name, "csv_email": email, "csv_phone": phone,
                    "match_by_email_id": by_email, "match_by_phone_id": by_phone,
                    "created_contact_id": contact_id,
                    "reason": "email совпал с одним контактом, телефон — с другим",
                })
                stats["created"] += 1
                continue

        contact_id, is_new = await find_or_create_contact(
            db, client_id=client_id, name=name, email=email, phone=phone,
            lookup_telegram_username=tg_username,
        )
        if is_new:
            stats["created"] += 1
        else:
            stats["merged"] += 1

    return stats


@router.get("/contacts/{contact_id}/export")
async def export_contact_data(
    contact_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """
    Экспорт всех данных контакта в JSON (требование 152-ФЗ — субъект
    персональных данных вправе получить свои данные по запросу).
    Только своих контактов.
    """
    client_id = int(client["sub"])
    c = await db.fetchrow(
        """SELECT id, name, email, phone, ref_code, tags,
                  utm_source, salebot_id, created_at, updated_at,
                  consent_pd_at, consent_pd_ip, consent_pd_policy_ver,
                  consent_marketing_at, consent_marketing_ip, consent_marketing_policy_ver
             FROM contacts WHERE id = $1 AND client_id = $2""",
        contact_id, client_id,
    )
    if not c:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    identities = await db.fetch(
        """SELECT pu.platform_slug, pu.platform_user_id, pu.username, pu.first_name, pu.last_name, pu.created_at
             FROM platform_users pu
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE pu.contact_id = $1 AND c_own.client_id = $2
            ORDER BY pu.platform_slug""",
        contact_id, client_id,
    )

    subscriptions = await db.fetch(
        """SELECT ch.platform_slug, ch.handle, ch.display_name,
                  puc.is_unsubscribed, puc.subscribed_at, puc.unsubscribed_at
             FROM platform_user_channels puc
             JOIN platform_users pu ON pu.id = puc.platform_user_id
             JOIN client_channels cc ON cc.id = puc.client_channel_id
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE pu.contact_id = $1
            ORDER BY ch.platform_slug""",
        contact_id,
    )

    events_participated = await db.fetch(
        """SELECT ep.event_id, e.title AS event_title, ep.is_registered,
                  ep.registered_at, ep.referrer_ref_code
             FROM event_participants ep
             JOIN events e ON e.id = ep.event_id
            WHERE ep.contact_id = $1
            ORDER BY ep.registered_at DESC""",
        contact_id,
    )

    return {
        "exported_at": "now",
        "contact": dict(c),
        "platform_identities": [dict(r) for r in identities],
        "channel_subscriptions": [dict(r) for r in subscriptions],
        "events_participated": [dict(r) for r in events_participated],
    }


@router.delete("/contacts/{contact_id}/personal-data")
async def erase_contact_personal_data(
    contact_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """
    Удаление персональных данных контакта (требование 152-ФЗ: «право на забвение»).

    Что делает:
    - Зануляет персональные поля: name, email, phone, email_normalized, phone_normalized
    - Удаляет все идентичности (platform_users) и подписки контакта
    - Помечает контакт is_active=FALSE
    - Запись в contacts остаётся (для целостности FK на event_participants,
      ref_code и т.п.), но без идентифицирующих данных

    Использовать только по запросу самого контакта или регуляторов.
    """
    client_id = int(client["sub"])
    own = await db.fetchval(
        "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
        contact_id, client_id,
    )
    if not own:
        raise HTTPException(status_code=404, detail="Контакт не найден")

    async with db.transaction():
        await db.execute(
            "DELETE FROM platform_users WHERE contact_id = $1",
            contact_id,
        )
        await db.execute(
            """UPDATE contacts
                  SET name = NULL,
                      phone = NULL, phone_normalized = NULL,
                      salebot_id = NULL,
                      tags = '[]'::jsonb,
                      utm_source = NULL,
                      consent_pd_at = NULL, consent_pd_ip = NULL,
                      consent_marketing_at = NULL, consent_marketing_ip = NULL,
                      is_active = FALSE,
                      updated_at = NOW()
                WHERE id = $1""",
            contact_id,
        )
    return {"ok": True, "message": "Персональные данные контакта удалены"}
