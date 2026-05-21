"""
Профиль клиента (Экосистема) — визитка + продукты.

Используется в Mini App в Хабе организатора во вкладке «🌐 Экосистема»,
а также для блока «А дальше» на завершённом событии и ленты Календаря.

Публичные эндпоинты (без авторизации, для Mini App):
  GET /api/v1/public/clients/{client_id}/profile
  GET /api/v1/public/clients/{client_id}/offerings
  GET /api/v1/public/clients/{client_id}/events?bucket=now|upcoming|past
  GET /api/v1/public/events/{slug}/landing

Приватные эндпоинты (авторизация клиента):
  GET   /api/v1/clients/me/profile      — получить свою визитку
  PATCH /api/v1/clients/me/profile      — обновить визитку
  GET   /api/v1/client-offerings        — список продуктов
  POST  /api/v1/client-offerings        — создать продукт
  PATCH /api/v1/client-offerings/{id}   — обновить продукт
  DELETE /api/v1/client-offerings/{id}  — удалить продукт
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Optional, Any
import asyncpg
import json

import httpx

from app.database import get_db, get_pool
from app.auth import get_current_client
from app.services.event_welcome import send_event_open_message
from app.services.social_links import normalize_social_links, normalize_telegram_link, telegram_api_id
from app.services.external_landing import resolve_external_ref_param, build_external_landing_url
from app.config import settings


# ═══════════════════════════════════════════
# ПУБЛИЧНЫЕ ЭНДПОИНТЫ (Mini App)
# ═══════════════════════════════════════════
public = APIRouter(prefix="/public", tags=["Публичный профиль клиента"])


def _parse_jsonb(v: Any, default):
    if v is None:
        return default
    if isinstance(v, (dict, list)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return default


@public.get("/clients/{client_id}/profile", summary="Визитка клиента (для Mini App)")
async def public_client_profile(client_id: int, db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """SELECT id, name, telegram_username,
                  brand_name, brand_logo_url, profile_photo_url, positioning, achievements,
                  owner_photo_url, owner_positioning, owner_achievements,
                  bio, social_links
             FROM clients
            WHERE id = $1 AND is_active = TRUE""",
        client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    d = dict(row)
    d["achievements"]       = _parse_jsonb(d.get("achievements"), [])
    d["owner_achievements"] = _parse_jsonb(d.get("owner_achievements"), [])
    d["social_links"]       = _parse_jsonb(d.get("social_links"), {})
    return d


@public.get("/clients/{client_id}/offerings", summary="Продукты клиента (для Mini App)")
async def public_client_offerings(client_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, title, description, action_url, is_paid, cover_url, sort_order
             FROM client_offerings
            WHERE client_id = $1
            ORDER BY is_paid DESC, sort_order, id""",
        client_id
    )
    items = [dict(r) for r in rows]
    return {
        "paid":  [i for i in items if i["is_paid"]],
        "free":  [i for i in items if not i["is_paid"]],
    }


@public.get("/clients/{client_id}/events", summary="События клиента, разбитые на бакеты")
async def public_client_events(
    client_id: int,
    bucket: Optional[str] = Query(None, description="now | upcoming | past — если не задан, возвращает все три"),
    tg_id: Optional[int] = Query(None, description="Telegram ID — для расчёта participation_status"),
    db: asyncpg.Connection = Depends(get_db),
):
    # Для конференций start_at/end_at в events игнорируем —
    # источник истины это conf_days (программа дней). Для остальных
    # типов событий берём поля из events напрямую.
    # Если задан tg_id — добавляем participation_status:
    #   'new' (нет записи в event_participants) | 'interested' (есть, не зарегистрирован) | 'registered'.
    rows = await db.fetch(
        """WITH conf_dates AS (
              -- Для конференций/турниров дата старта/окончания события =
              -- MIN/MAX между датами программы (conf_days) и датами этапов
              -- (conf_stages). Этап может существовать без детальных дней
              -- (напр. «Предстарт 15–26 июн»), и его даты тоже должны
              -- учитываться — иначе турнир со старшим conf_days, но ранним
              -- этапом, уезжает в конец списка ниже мероприятий, которые
              -- по факту начинаются позже.
              -- LEAST/GREATEST в Postgres игнорируют NULL — если этапов
              -- или дней нет, используется только то, что есть.
              SELECT e.id AS event_id,
                     LEAST(
                       (SELECT (d2.day_date + COALESCE(
                                  NULLIF(d2.open_time,'')::time,
                                  (SELECT MIN(NULLIF(s.start_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                  '00:00'::time
                                )) AT TIME ZONE 'Europe/Moscow'
                          FROM conf_days d2
                          WHERE d2.event_id = e.id
                          ORDER BY d2.day_number ASC LIMIT 1),
                       (SELECT MIN(st.start_date::timestamp AT TIME ZONE 'Europe/Moscow')
                          FROM conf_stages st
                          WHERE st.event_id = e.id AND st.start_date IS NOT NULL)
                     ) AS start_at,
                     GREATEST(
                       (SELECT (d2.day_date + COALESCE(
                                  NULLIF(d2.close_time,'')::time,
                                  (SELECT MAX(NULLIF(s.end_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                  (SELECT MAX(NULLIF(s.start_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                  '23:59'::time
                                )) AT TIME ZONE 'Europe/Moscow'
                          FROM conf_days d2
                          WHERE d2.event_id = e.id
                          ORDER BY d2.day_number DESC LIMIT 1),
                       (SELECT MAX((st.end_date + '23:59'::time) AT TIME ZONE 'Europe/Moscow')
                          FROM conf_stages st
                          WHERE st.event_id = e.id AND st.end_date IS NOT NULL)
                     ) AS end_at
                FROM events e
               WHERE e.module_slug IN ('conference', 'turnir')
            ),
            user_participation AS (
              SELECT ep.event_id, ep.is_registered
                FROM event_participants ep
                JOIN contacts c        ON c.id  = ep.contact_id
                JOIN platform_users pu ON pu.contact_id = c.id
               WHERE pu.platform_slug = 'telegram'
                 AND pu.platform_user_id = $2
            )
            -- Для конференций приоритет — даты программы (conf_days). Но если
            -- программа ещё не заведена, а в events.start_at дата уже выставлена —
            -- fallback на неё, чтобы событие не «проваливалось» в конец из-за NULL
            -- (видно в Mini App «Календарь»: «Ж.И.В.У.» без conf_days оказывалось
            -- ниже мероприятия с более поздним start_at).
            SELECT e.id, e.slug, e.title, e.description, e.module_slug,
                   (SELECT url FROM event_posters
                     WHERE event_id = e.id
                     ORDER BY CASE orientation
                                WHEN 'square'     THEN 1
                                WHEN 'horizontal' THEN 2
                                WHEN 'vertical'   THEN 3
                                ELSE 4
                              END, sort, id
                     LIMIT 1) AS poster_url,
                   e.status,
                   COALESCE(
                     CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END,
                     e.start_at
                   ) AS start_at,
                   COALESCE(
                     CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at END,
                     e.end_at
                   ) AS end_at,
                   CASE
                     WHEN COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at) IS NULL
                       OR COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at)   IS NULL
                          THEN 'upcoming'
                     WHEN NOW() BETWEEN
                          COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END, e.start_at)
                          AND
                          COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at)
                          THEN 'now'
                     WHEN COALESCE(CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.end_at   END, e.end_at) < NOW()
                          THEN 'past'
                     ELSE 'upcoming'
                   END AS bucket,
                   CASE
                     WHEN $2::text IS NULL          THEN NULL
                     WHEN up.event_id IS NULL       THEN 'new'
                     WHEN up.is_registered IS TRUE  THEN 'registered'
                     ELSE 'interested'
                   END AS participation_status
              FROM events e
              LEFT JOIN conf_dates cd        ON cd.event_id = e.id
              LEFT JOIN user_participation up ON up.event_id = e.id
             WHERE e.client_id = $1 AND e.status IN ('published','ended')
             ORDER BY COALESCE(
                        CASE WHEN e.module_slug IN ('conference','turnir') THEN cd.start_at END,
                        e.start_at
                      ) NULLS LAST""",
        client_id,
        str(tg_id) if tg_id else None,
    )
    items = [dict(r) for r in rows]
    if bucket:
        items = [i for i in items if i["bucket"] == bucket]
        return {"items": items}
    return {
        "now":      [i for i in items if i["bucket"] == "now"],
        "upcoming": [i for i in items if i["bucket"] == "upcoming"],
        "past":     [i for i in items if i["bucket"] == "past"],
    }


@public.get(
    "/events/{event_id}/share-texts",
    summary="Тексты-примеры реф-программы для шеринга (публично, для Mini App)"
)
async def public_share_texts(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, content, sort
             FROM event_referral_share_texts
            WHERE event_id = $1
            ORDER BY sort, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@public.get(
    "/events/{event_id}/share-materials",
    summary="Картинки реф-программы для шеринга (публично, для Mini App)"
)
async def public_share_materials(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, image_url, source, sort
             FROM event_referral_materials
            WHERE event_id = $1
            ORDER BY sort, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@public.get("/events/{event_id}/collaborators", summary="Коллабораторы события (публично, для Mini App)")
async def public_event_collaborators(
    event_id: int,
    role: Optional[str] = None,  # 'organizer' / 'speaker' / 'partner' / None=все
    db: asyncpg.Connection = Depends(get_db),
):
    sql = """
        SELECT ec.id, ec.role, ec.sort_order,
               co.id AS collaborator_id, co.name, co.title, co.photo_url,
               co.achievements, co.tg_channel_url, co.instagram_url,
               co.website_url, co.personal_tg_username
          FROM event_collaborators ec
          JOIN collaborators co ON co.id = ec.speaker_id
         WHERE ec.event_id = $1 AND ec.is_visible = TRUE
    """
    args: list[Any] = [event_id]
    if role:
        args.append(role)
        sql += f" AND ec.role = ${len(args)}"
    # Тот же порядок, что и в очереди рассылок (broadcasts.py: speaker_intro):
    # ORDER BY priority, sort_order, id — даём клиенту единую логику приоритета.
    sql += " ORDER BY ec.priority NULLS LAST, ec.sort_order, ec.id"
    rows = await db.fetch(sql, *args)
    return {"items": [dict(r) for r in rows]}


@public.get("/events/{event_id}/raffle/prizes", summary="Призы розыгрыша (публично, для Mini App)")
async def public_raffle_prizes(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order
             FROM event_raffle_prizes
            WHERE event_id = $1 AND is_active = TRUE
            ORDER BY sort_order, id""",
        event_id
    )
    return {"items": [dict(r) for r in rows]}


@public.get("/events/{event_id}/raffle/settings", summary="Настройки розыгрыша (публично, для Mini App)")
async def public_raffle_settings(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """SELECT is_enabled, draw_at, subscription_grants_starter_ticket, intro_text
             FROM event_raffle_settings WHERE event_id = $1""",
        event_id
    )
    if not row:
        return {"is_enabled": False, "draw_at": None, "subscription_grants_starter_ticket": True, "intro_text": None}
    return dict(row)


@public.get(
    "/events/{slug}/landing-redirect",
    summary="Узкий endpoint для inline-скрипта Mini App: куда редиректить ДО React",
)
async def public_event_landing_redirect(
    slug: str,
    background_tasks: BackgroundTasks,
    tg_id: Optional[int] = None,
    pid: Optional[str] = None,
    utm_source: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    """Если событию задан landing_url и пользователь ещё не зарегистрирован
    (или tg_id не передан) — возвращает {redirect_url: ...} с пробросом
    параметров. Иначе пустой объект. Используется в mini-app/index.html
    inline-скриптом для мгновенного редиректа на сторонний лендинг."""
    row = await db.fetchrow(
        "SELECT id, client_id, landing_url, status FROM events WHERE slug = $1 LIMIT 1",
        slug,
    )
    if not row:
        return {}
    if row["status"] != "published":
        return {}
    landing_url = (row["landing_url"] or "").strip()
    if not landing_url:
        return {}

    # Если уже зарегистрирован — не редиректим (Mini App покажет welcome
    # или сразу Программу).
    if tg_id is not None:
        is_reg = await db.fetchval(
            """SELECT ep.is_registered
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id
                WHERE ep.event_id = $1
                  AND pu.platform_slug = 'telegram'
                  AND pu.platform_user_id = $2
                LIMIT 1""",
            row["id"], str(tg_id),
        )
        if is_reg:
            return {}

    external_ref_param = await resolve_external_ref_param(db, row["client_id"], pid)
    redirect_url = build_external_landing_url(
        landing_url,
        event_slug=slug,
        tg_id=tg_id,
        pid=pid,
        utm_source=utm_source,
        external_ref_param=external_ref_param,
    )

    # При редиректе на сторонний лендинг React-bundle Mini App не запустится →
    # POST /event не придёт. Шлём контекстное приветствие в бот сами,
    # фоном — чтобы не задерживать ответ. tg_id обязателен (без него некому слать).
    if tg_id is not None:
        pool = await get_pool()
        if pool:
            background_tasks.add_task(
                send_event_open_message,
                pool,
                tg_id=int(tg_id),
                event_slug=slug,
                client_id_hint=row["client_id"],
                partner_id=pid or "",
            )

    return {"redirect_url": redirect_url}


@public.get(
    "/events/{slug}/external-ref",
    summary="Партнёрский параметр внешней платформы клиента по pid (gcpc=fdd97 и т.п.)",
)
async def public_event_external_ref(
    slug: str,
    pid: Optional[str] = None,
    db: asyncpg.Connection = Depends(get_db),
):
    """Резолвит pid → collaborators.external_ref_param. Используется в SSR /l/[slug]
    и в Mini App SPA-навигации (когда landing-redirect ДО React не сработал —
    например, для draft-событий или при внутренней навигации внутри Mini App).
    Работает независимо от status события. Если pid не привязан к коллаборатору
    с external_ref_param — возвращает {external_ref_param: null}."""
    if not pid:
        return {"external_ref_param": None}
    row = await db.fetchrow(
        "SELECT client_id FROM events WHERE slug = $1 LIMIT 1", slug,
    )
    if not row:
        return {"external_ref_param": None}
    value = await resolve_external_ref_param(db, row["client_id"], pid)
    return {"external_ref_param": value}


@public.get(
    "/events/{slug}/bot-handle",
    summary="Handle telegram-бота для события (VIP-клиент или общий @pluson_bot)",
)
async def public_event_bot_handle(slug: str, db: asyncpg.Connection = Depends(get_db)):
    """Используется страницей /r/{slug} в fallback'е — отдаёт client_id события
    и handle бота (для информации о VIP-статусе)."""
    row = await db.fetchrow(
        "SELECT client_id FROM events WHERE slug = $1 LIMIT 1", slug,
    )
    if not row:
        return {"bot_handle": "pluson_bot", "is_vip_bot": False, "client_id": None}
    vip_handle = await db.fetchval(
        """SELECT ch.handle
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
              AND cc.is_active = TRUE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id LIMIT 1""",
        row["client_id"],
    )
    if vip_handle:
        return {"bot_handle": vip_handle.lstrip('@'), "is_vip_bot": True, "client_id": row["client_id"]}
    return {"bot_handle": "pluson_bot", "is_vip_bot": False, "client_id": row["client_id"]}


@public.get("/events/{slug}/landing", summary="Данные лендинга события (для Mini App до регистрации)")
async def public_event_landing(slug: str, db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """WITH cd AS (
              -- start = первый день: open_time дня 1, иначе MIN(start_time) сессий дня 1
              -- end   = последний день: close_time, иначе MAX(end_time) сессий посл. дня
              SELECT d.event_id,
                     (SELECT (d2.day_date + COALESCE(
                                NULLIF(d2.open_time,'')::time,
                                (SELECT MIN(NULLIF(s.start_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                '00:00'::time
                              )) AT TIME ZONE 'Europe/Moscow'
                        FROM conf_days d2
                        WHERE d2.event_id = d.event_id
                        ORDER BY d2.day_number ASC LIMIT 1) AS start_at,
                     (SELECT (d2.day_date + COALESCE(
                                NULLIF(d2.close_time,'')::time,
                                (SELECT MAX(NULLIF(s.end_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                (SELECT MAX(NULLIF(s.start_time,'')::time)
                                   FROM conf_sessions s
                                  WHERE s.event_id = d2.event_id AND s.day = d2.day_number),
                                '23:59'::time
                              )) AT TIME ZONE 'Europe/Moscow'
                        FROM conf_days d2
                        WHERE d2.event_id = d.event_id
                        ORDER BY d2.day_number DESC LIMIT 1) AS end_at
                FROM conf_days d
               GROUP BY d.event_id
            )
            SELECT e.id, e.client_id, e.slug, e.title, e.description,
                   e.description_post_register, e.module_slug,
                   (SELECT url FROM event_posters
                     WHERE event_id = e.id
                     ORDER BY CASE orientation
                                WHEN 'square'     THEN 1
                                WHEN 'horizontal' THEN 2
                                WHEN 'vertical'   THEN 3
                                ELSE 4
                              END, sort, id
                     LIMIT 1) AS poster_url,
                   e.landing_url, e.address, e.status,
                   CASE WHEN e.module_slug IN ('conference','turnir')
                        THEN cd.start_at ELSE e.start_at END AS start_at,
                   CASE WHEN e.module_slug IN ('conference','turnir')
                        THEN cd.end_at   ELSE e.end_at   END AS end_at,
                   e.vip_url, e.vip_button_label,
                   e.chat_url, e.chat_member_count_label, e.require_subscription,
                   e.stream_url, e.skip_contact_form,
                   c.name AS client_name, c.brand_name AS client_brand,
                   c.profile_photo_url AS client_photo,
                   c.brand_logo_url AS client_brand_logo,
                   (SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                      FROM channels ch
                      JOIN client_channels cc ON cc.channel_id = ch.id
                     WHERE cc.client_id = e.client_id
                       AND ch.platform_slug = 'telegram'
                       AND cc.is_active = TRUE
                       AND ch.is_system = FALSE
                       AND ch.bot_token IS NOT NULL
                     LIMIT 1) AS client_bot_handle,
                   COALESCE((SELECT is_enabled FROM event_referral_settings
                              WHERE event_id = e.id), FALSE) AS referral_enabled,
                   COALESCE((SELECT is_enabled FROM event_raffle_settings
                              WHERE event_id = e.id), FALSE) AS raffle_enabled
              FROM events e
              JOIN clients c ON c.id = e.client_id
              LEFT JOIN cd ON cd.event_id = e.id
             WHERE e.slug = $1""",
        slug
    )
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    d = dict(row)

    # Афиши события (горизонтальные используем как hero)
    posters = await db.fetch(
        """SELECT url, orientation FROM event_posters
            WHERE event_id = $1 ORDER BY sort, id""",
        row["id"]
    )
    d["posters"] = [dict(p) for p in posters]

    # Successor — автоматически: ближайшее опубликованное событие того же
    # клиента, начинающееся ПОСЛЕ конца текущего. Для конференций start_at
    # берём из conf_days (MIN day_date + open_time, Europe/Moscow), для
    # остальных модулей — events.start_at. Текущее событие исключаем.
    succ = await db.fetchrow(
        """WITH ev_start AS (
              SELECT e.id, e.client_id, e.slug, e.title, e.module_slug, e.status,
                     CASE WHEN e.module_slug IN ('conference','turnir') THEN
                       (SELECT (d.day_date + COALESCE(
                                  NULLIF(d.open_time,'')::time,
                                  (SELECT MIN(NULLIF(s.start_time,'')::time)
                                     FROM conf_sessions s
                                    WHERE s.event_id = e.id AND s.day = d.day_number),
                                  '00:00'::time
                                )) AT TIME ZONE 'Europe/Moscow'
                          FROM conf_days d
                         WHERE d.event_id = e.id
                         ORDER BY d.day_number ASC LIMIT 1)
                     ELSE e.start_at END AS start_at
                FROM events e
            )
            SELECT s.id, s.slug, s.title, s.start_at,
                   (SELECT url FROM event_posters
                     WHERE event_id = s.id
                     ORDER BY CASE orientation
                                WHEN 'square'     THEN 1
                                WHEN 'horizontal' THEN 2
                                WHEN 'vertical'   THEN 3
                                ELSE 4
                              END, sort, id
                     LIMIT 1) AS poster_url
              FROM ev_start s
             WHERE s.client_id = $1
               AND s.status = 'published'
               AND s.id <> $2
               AND s.start_at IS NOT NULL
               AND s.start_at > COALESCE($3::timestamptz, NOW())
             ORDER BY s.start_at ASC
             LIMIT 1""",
        row["client_id"], row["id"], d.get("end_at") or d.get("start_at")
    )
    d["successor"] = dict(succ) if succ else None

    return d


# ═══════════════════════════════════════════
# ПРИВАТНЫЕ ЭНДПОИНТЫ (дашборд клиента)
# ═══════════════════════════════════════════
profile_router = APIRouter(prefix="/clients/me", tags=["Профиль клиента"])


class ProfileUpdate(BaseModel):
    # Бренд
    brand_name:         Optional[str]  = None
    brand_logo_url:     Optional[str]  = None       # логотип в углу страниц
    profile_photo_url:  Optional[str]  = None       # фото бренда
    positioning:        Optional[str]  = None       # позиционирование бренда
    achievements:       Optional[list] = None       # [{label, value}] факты бренда
    # Основатель (имя берётся из clients.name — не редактируется в UI)
    owner_photo_url:    Optional[str]  = None
    owner_positioning:  Optional[str]  = None
    owner_achievements: Optional[list] = None       # [{label, value}] факты основателя
    bio:                Optional[str]  = None       # биография основателя
    social_links:       Optional[dict] = None       # соцсети основателя


@profile_router.get("/profile", summary="Получить свою визитку")
async def get_my_profile(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await db.fetchrow(
        """SELECT id, name, telegram_username, email,
                  brand_name, brand_logo_url, profile_photo_url, positioning, achievements,
                  owner_photo_url, owner_positioning, owner_achievements,
                  bio, social_links
             FROM clients WHERE id = $1""",
        int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    d = dict(row)
    d["achievements"]       = _parse_jsonb(d.get("achievements"), [])
    d["owner_achievements"] = _parse_jsonb(d.get("owner_achievements"), [])
    d["social_links"]       = _parse_jsonb(d.get("social_links"), {})
    return d


@profile_router.patch("/profile", summary="Обновить визитку")
async def update_my_profile(
    data: ProfileUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    sets: list[str] = []
    args: list[Any] = []

    def add(field: str, value: Any, jsonb: bool = False):
        sets.append(f"{field} = ${len(args)+1}" + ("::jsonb" if jsonb else ""))
        args.append(json.dumps(value) if jsonb else value)

    if data.brand_name        is not None: add("brand_name",        data.brand_name or None)
    if data.brand_logo_url    is not None: add("brand_logo_url",    data.brand_logo_url or None)
    if data.profile_photo_url is not None: add("profile_photo_url", data.profile_photo_url or None)
    if data.positioning       is not None: add("positioning",       data.positioning or None)
    if data.achievements      is not None: add("achievements",      data.achievements, jsonb=True)

    if data.owner_photo_url    is not None: add("owner_photo_url",    data.owner_photo_url or None)
    if data.owner_positioning  is not None: add("owner_positioning",  data.owner_positioning or None)
    if data.owner_achievements is not None: add("owner_achievements", data.owner_achievements, jsonb=True)

    if data.bio          is not None: add("bio",          data.bio or None)
    if data.social_links is not None:
        # Приводим TG/VK ссылки к https-формату — для воронки лид-магнитов и согласованности.
        normalized = normalize_social_links(data.social_links)
        # Авто-резолв VK group_id для проверки подписки на сообщество клиента.
        # Если поле vk изменилось (или vk_group_id отсутствует) — резолвим через utils.resolveScreenName.
        if normalized.get("vk"):
            from app.services.social_links import vk_screen_name_from_link
            from app.services.vk_api import vk_call
            screen = vk_screen_name_from_link(normalized["vk"])
            if screen:
                try:
                    resp = await vk_call("utils.resolveScreenName", {"screen_name": screen})
                    if isinstance(resp, dict) and resp.get("type") in ("group", "page") and resp.get("object_id"):
                        normalized["vk_group_id"] = int(resp["object_id"])
                    else:
                        normalized.pop("vk_group_id", None)
                except Exception as _e:
                    # резолв не получился — не блокируем сохранение профиля
                    pass
        else:
            normalized.pop("vk_group_id", None)
        add("social_links", normalized, jsonb=True)

    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    args.append(int(client["sub"]))
    row = await db.fetchrow(
        f"""UPDATE clients SET {', '.join(sets)}
            WHERE id = ${len(args)}
            RETURNING id,
                      brand_name, brand_logo_url, profile_photo_url, positioning, achievements,
                      owner_photo_url, owner_positioning, owner_achievements,
                      bio, social_links""",
        *args
    )
    d = dict(row)
    d["achievements"]       = _parse_jsonb(d.get("achievements"), [])
    d["owner_achievements"] = _parse_jsonb(d.get("owner_achievements"), [])
    d["social_links"]       = _parse_jsonb(d.get("social_links"), {})
    return d


class ResolveTgChatIdIn(BaseModel):
    username: Optional[str] = None  # @xxx или xxx — если не задан, берём из social_links.telegram


@profile_router.post("/profile/resolve-telegram-chat-id",
                     summary="Получить chat_id канала по @username и сохранить в social_links.telegram_chat_id")
async def resolve_telegram_chat_id(
    payload: ResolveTgChatIdIn = ResolveTgChatIdIn(),
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Получить chat_id публичного TG-канала через `getChat` и сохранить в
    `social_links.telegram_chat_id`.

    Источник @username:
    - Если в body передан `username` (`@foo` или `foo`) — берём его. Это путь
      «у меня в поле сохранена инвайт-ссылка, но реально канал имеет @username».
    - Иначе — берём из `social_links.telegram` (если там открытый канал).

    Для канала, у которого нет публичного @username — отдаём 400.
    """
    client_id = int(client["sub"])
    row = await db.fetchrow("SELECT social_links FROM clients WHERE id = $1", client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    social = row["social_links"] or {}
    if isinstance(social, str):
        social = json.loads(social)

    # 1) пытаемся взять username из payload
    api_id = ""
    if payload.username and payload.username.strip():
        u = payload.username.strip().lstrip("@")
        u = u.split("/")[-1]  # на случай, если вставили https://t.me/foo
        if u:
            api_id = f"@{u}"
    # 2) если не передан — берём из social_links.telegram
    if not api_id:
        tg_link = (social or {}).get("telegram") or ""
        if not tg_link:
            raise HTTPException(status_code=400, detail="Введите @username канала или укажите ссылку на канал в поле выше")
        api_id = telegram_api_id(tg_link)
    if not api_id:
        raise HTTPException(
            status_code=400,
            detail="invite_only",  # фронт превратит в попап «введите @username или см. инструкцию»
        )
    token = settings.telegram_bot_token
    if not token:
        raise HTTPException(status_code=500, detail="Bot token не настроен")
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": api_id},
            )
            data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Не дозвонились до Telegram: {e}")
    if not data.get("ok"):
        desc = data.get("description", "unknown")
        raise HTTPException(status_code=400, detail=f"Telegram отказал: {desc}")
    chat_id = data["result"].get("id")
    if not chat_id:
        raise HTTPException(status_code=502, detail="getChat не вернул id")
    new_social = dict(social) if isinstance(social, dict) else {}
    new_social["telegram_chat_id"] = chat_id
    await db.execute(
        "UPDATE clients SET social_links = $1::jsonb WHERE id = $2",
        json.dumps(new_social), client_id,
    )
    return {"chat_id": chat_id, "username": api_id}


# ═══════════════════════════════════════════
# Продукты клиента (CRUD)
# ═══════════════════════════════════════════
offerings_router = APIRouter(prefix="/client-offerings", tags=["Продукты клиента"])


class OfferingIn(BaseModel):
    title:        str
    description:  Optional[str] = None
    action_url:   Optional[str] = None
    is_paid:      bool = True
    cover_url:    Optional[str] = None
    sort_order:   int = 0


class OfferingPatch(BaseModel):
    title:        Optional[str] = None
    description:  Optional[str] = None
    action_url:   Optional[str] = None
    is_paid:      Optional[bool] = None
    cover_url:    Optional[str] = None
    sort_order:   Optional[int] = None


@offerings_router.get("", summary="Список продуктов клиента")
async def list_offerings(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        """SELECT id, title, description, action_url, is_paid, cover_url, sort_order, created_at, updated_at
             FROM client_offerings
            WHERE client_id = $1
            ORDER BY is_paid DESC, sort_order, id""",
        int(client["sub"])
    )
    return {"items": [dict(r) for r in rows]}


@offerings_router.post("", summary="Создать продукт")
async def create_offering(
    data: OfferingIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await db.fetchrow(
        """INSERT INTO client_offerings
              (client_id, title, description, action_url, is_paid, cover_url, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, title, description, action_url, is_paid, cover_url, sort_order""",
        int(client["sub"]), data.title.strip(), data.description, data.action_url,
        data.is_paid, data.cover_url, data.sort_order
    )
    return dict(row)


@offerings_router.patch("/{offering_id}", summary="Обновить продукт")
async def update_offering(
    offering_id: int,
    data: OfferingPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    sets = []
    args: list[Any] = []
    for field in ("title", "description", "action_url", "is_paid", "cover_url", "sort_order"):
        v = getattr(data, field)
        if v is not None:
            sets.append(f"{field} = ${len(args)+1}")
            args.append(v.strip() if isinstance(v, str) else v)
    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")
    sets.append("updated_at = NOW()")
    args.extend([offering_id, int(client["sub"])])
    row = await db.fetchrow(
        f"""UPDATE client_offerings SET {', '.join(sets)}
            WHERE id = ${len(args)-1} AND client_id = ${len(args)}
            RETURNING id, title, description, action_url, is_paid, cover_url, sort_order""",
        *args
    )
    if not row:
        raise HTTPException(status_code=404, detail="Продукт не найден")
    return dict(row)


@offerings_router.delete("/{offering_id}", summary="Удалить продукт")
async def delete_offering(
    offering_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    res = await db.execute(
        "DELETE FROM client_offerings WHERE id = $1 AND client_id = $2",
        offering_id, int(client["sub"])
    )
    if res == "DELETE 0":
        raise HTTPException(status_code=404, detail="Продукт не найден")
    return {"ok": True}
