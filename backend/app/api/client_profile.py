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

from app.database import get_db, get_pool
from app.auth import get_current_client
from app.services.event_welcome import send_event_open_message


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
                  owner_name, owner_photo_url, owner_positioning, owner_achievements,
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
            ),
            user_participation AS (
              SELECT ep.event_id, ep.is_registered
                FROM event_participants ep
                JOIN contacts c        ON c.id  = ep.contact_id
                JOIN platform_users pu ON pu.contact_id = c.id
               WHERE pu.platform_slug = 'telegram'
                 AND pu.platform_user_id = $2
            )
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
                   CASE WHEN e.module_slug = 'conference'
                        THEN cd.start_at ELSE e.start_at END AS start_at,
                   CASE WHEN e.module_slug = 'conference'
                        THEN cd.end_at   ELSE e.end_at   END AS end_at,
                   CASE
                     WHEN (CASE WHEN e.module_slug = 'conference'
                                THEN cd.start_at ELSE e.start_at END) IS NULL
                       OR (CASE WHEN e.module_slug = 'conference'
                                THEN cd.end_at   ELSE e.end_at   END) IS NULL
                          THEN 'upcoming'
                     WHEN NOW() BETWEEN
                          (CASE WHEN e.module_slug = 'conference'
                                THEN cd.start_at ELSE e.start_at END)
                          AND
                          (CASE WHEN e.module_slug = 'conference'
                                THEN cd.end_at   ELSE e.end_at   END)
                          THEN 'now'
                     WHEN (CASE WHEN e.module_slug = 'conference'
                                THEN cd.end_at   ELSE e.end_at   END) < NOW()
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
             ORDER BY (CASE WHEN e.module_slug = 'conference'
                            THEN cd.start_at ELSE e.start_at END) NULLS LAST""",
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

    # Если pid резолвится в коллаборатора с external_ref_param — приписываем
    # его партнёрский параметр (например, gcpc=fdd97) к URL клиентского
    # лендинга. Это связывает партнёра ПЛЮСОН с партнёром во внешней системе
    # клиента (GetCourse / Bizon360 и т.п.). Если что-то пошло не так —
    # просто не приписываем, основной редирект не ломаем.
    external_ref_param = None
    if pid:
        try:
            external_ref_param = await db.fetchval(
                """SELECT col.external_ref_param
                     FROM contacts c
                     JOIN collaborators col ON col.contact_id = c.id
                    WHERE c.client_id = $1
                      AND (c.ref_code = $2 OR c.merged_ref_codes ? $2)
                      AND col.external_ref_param IS NOT NULL
                      AND col.external_ref_param <> ''
                    LIMIT 1""",
                row["client_id"], pid,
            )
        except Exception:
            external_ref_param = None

    from urllib.parse import urlencode
    qs = {"event_slug": slug}
    if tg_id is not None: qs["tg_id"] = str(tg_id)
    if pid:               qs["pid"] = pid
    if utm_source:        qs["utm_source"] = utm_source
    sep = "&" if "?" in landing_url else "?"
    redirect_url = landing_url + sep + urlencode(qs)
    if external_ref_param:
        redirect_url += "&" + external_ref_param.lstrip("?&")

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
            SELECT e.id, e.client_id, e.slug, e.title, e.description, e.module_slug,
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
                   CASE WHEN e.module_slug = 'conference'
                        THEN cd.start_at ELSE e.start_at END AS start_at,
                   CASE WHEN e.module_slug = 'conference'
                        THEN cd.end_at   ELSE e.end_at   END AS end_at,
                   e.vip_url,
                   e.chat_url, e.chat_member_count_label, e.require_subscription,
                   e.stream_url,
                   c.name AS client_name, c.brand_name AS client_brand,
                   c.profile_photo_url AS client_photo,
                   c.brand_logo_url AS client_brand_logo,
                   (SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                      FROM channels ch
                     WHERE ch.client_id = e.client_id
                       AND ch.platform_slug = 'telegram'
                       AND ch.is_active = TRUE
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
                     CASE WHEN e.module_slug = 'conference' THEN
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
    # Основатель
    owner_name:         Optional[str]  = None
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
                  owner_name, owner_photo_url, owner_positioning, owner_achievements,
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

    if data.owner_name         is not None: add("owner_name",         data.owner_name or None)
    if data.owner_photo_url    is not None: add("owner_photo_url",    data.owner_photo_url or None)
    if data.owner_positioning  is not None: add("owner_positioning",  data.owner_positioning or None)
    if data.owner_achievements is not None: add("owner_achievements", data.owner_achievements, jsonb=True)

    if data.bio          is not None: add("bio",          data.bio or None)
    if data.social_links is not None: add("social_links", data.social_links, jsonb=True)

    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    args.append(int(client["sub"]))
    row = await db.fetchrow(
        f"""UPDATE clients SET {', '.join(sets)}
            WHERE id = ${len(args)}
            RETURNING id,
                      brand_name, brand_logo_url, profile_photo_url, positioning, achievements,
                      owner_name, owner_photo_url, owner_positioning, owner_achievements,
                      bio, social_links""",
        *args
    )
    d = dict(row)
    d["achievements"]       = _parse_jsonb(d.get("achievements"), [])
    d["owner_achievements"] = _parse_jsonb(d.get("owner_achievements"), [])
    d["social_links"]       = _parse_jsonb(d.get("social_links"), {})
    return d


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
