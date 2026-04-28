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
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Optional, Any
import asyncpg
import json

from app.database import get_db
from app.auth import get_current_client


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
        """SELECT id, name, telegram_username, brand_name,
                  bio, profile_photo_url, positioning,
                  achievements, social_links
             FROM clients
            WHERE id = $1 AND is_active = TRUE""",
        client_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    d = dict(row)
    d["achievements"] = _parse_jsonb(d.get("achievements"), [])
    d["social_links"] = _parse_jsonb(d.get("social_links"), {})
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
    db: asyncpg.Connection = Depends(get_db),
):
    # Для конференций start_at/end_at в events игнорируем —
    # источник истины это conf_days (программа дней). Для остальных
    # типов событий берём поля из events напрямую.
    rows = await db.fetch(
        """WITH conf_dates AS (
              SELECT event_id,
                     MIN((day_date + COALESCE(open_time,  '00:00'::time))
                         AT TIME ZONE 'Europe/Moscow') AS start_at,
                     MAX((day_date + COALESCE(close_time, '23:59'::time))
                         AT TIME ZONE 'Europe/Moscow') AS end_at
                FROM conf_days
               GROUP BY event_id
            )
            SELECT e.id, e.slug, e.title, e.description, e.module_slug,
                   COALESCE(
                     (SELECT url FROM event_posters
                       WHERE event_id = e.id
                       ORDER BY CASE orientation
                                  WHEN 'square'     THEN 1
                                  WHEN 'horizontal' THEN 2
                                  WHEN 'vertical'   THEN 3
                                  ELSE 4
                                END, sort, id
                       LIMIT 1),
                     e.poster_url
                   ) AS poster_url,
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
                   END AS bucket
              FROM events e
              LEFT JOIN conf_dates cd ON cd.event_id = e.id
             WHERE e.client_id = $1 AND e.status IN ('published','ended')
             ORDER BY (CASE WHEN e.module_slug = 'conference'
                            THEN cd.start_at ELSE e.start_at END) NULLS LAST""",
        client_id
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


@public.get("/events/{slug}/landing", summary="Данные лендинга события (для Mini App до регистрации)")
async def public_event_landing(slug: str, db: asyncpg.Connection = Depends(get_db)):
    row = await db.fetchrow(
        """WITH cd AS (
              SELECT event_id,
                     MIN((day_date + COALESCE(open_time,  '00:00'::time))
                         AT TIME ZONE 'Europe/Moscow') AS start_at,
                     MAX((day_date + COALESCE(close_time, '23:59'::time))
                         AT TIME ZONE 'Europe/Moscow') AS end_at
                FROM conf_days
               GROUP BY event_id
            )
            SELECT e.id, e.client_id, e.slug, e.title, e.description, e.module_slug,
                   COALESCE(
                     (SELECT url FROM event_posters
                       WHERE event_id = e.id
                       ORDER BY CASE orientation
                                  WHEN 'square'     THEN 1
                                  WHEN 'horizontal' THEN 2
                                  WHEN 'vertical'   THEN 3
                                  ELSE 4
                                END, sort, id
                       LIMIT 1),
                     e.poster_url
                   ) AS poster_url,
                   e.landing_url, e.address, e.status,
                   CASE WHEN e.module_slug = 'conference'
                        THEN cd.start_at ELSE e.start_at END AS start_at,
                   CASE WHEN e.module_slug = 'conference'
                        THEN cd.end_at   ELSE e.end_at   END AS end_at,
                   e.successor_event_id,
                   e.has_vip_tariff, e.vip_price, e.vip_url, e.vip_title, e.vip_description,
                   e.chat_url, e.chat_subscriptions_required, e.chat_member_count_label,
                   c.name AS client_name, c.brand_name AS client_brand,
                   c.profile_photo_url AS client_photo
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

    # Successor (следующее событие)
    if row["successor_event_id"]:
        succ = await db.fetchrow(
            """SELECT id, slug, title, poster_url, start_at
                 FROM events WHERE id = $1""",
            row["successor_event_id"]
        )
        d["successor"] = dict(succ) if succ else None
    else:
        d["successor"] = None

    return d


# ═══════════════════════════════════════════
# ПРИВАТНЫЕ ЭНДПОИНТЫ (дашборд клиента)
# ═══════════════════════════════════════════
profile_router = APIRouter(prefix="/clients/me", tags=["Профиль клиента"])


class ProfileUpdate(BaseModel):
    brand_name:         Optional[str] = None      # бренд (iVISION) — миграция 042
    bio:                Optional[str] = None
    profile_photo_url:  Optional[str] = None
    positioning:        Optional[str] = None      # роль владельца (например «основатель iVISION»)
    achievements:       Optional[list] = None     # [{label, value}] — регалии 4 шт. для сетки 2×2
    social_links:       Optional[dict] = None     # {instagram, telegram, youtube, vk, website}


@profile_router.get("/profile", summary="Получить свою визитку")
async def get_my_profile(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    row = await db.fetchrow(
        """SELECT id, name, telegram_username, email, brand_name,
                  bio, profile_photo_url, positioning,
                  achievements, social_links
             FROM clients WHERE id = $1""",
        int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    d = dict(row)
    d["achievements"] = _parse_jsonb(d.get("achievements"), [])
    d["social_links"] = _parse_jsonb(d.get("social_links"), {})
    return d


@profile_router.patch("/profile", summary="Обновить визитку")
async def update_my_profile(
    data: ProfileUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    sets = []
    args: list[Any] = []
    if data.brand_name is not None:
        sets.append(f"brand_name = ${len(args)+1}");         args.append(data.brand_name or None)
    if data.bio is not None:
        sets.append(f"bio = ${len(args)+1}");                args.append(data.bio)
    if data.profile_photo_url is not None:
        sets.append(f"profile_photo_url = ${len(args)+1}");  args.append(data.profile_photo_url)
    if data.positioning is not None:
        sets.append(f"positioning = ${len(args)+1}");        args.append(data.positioning)
    if data.achievements is not None:
        sets.append(f"achievements = ${len(args)+1}::jsonb"); args.append(json.dumps(data.achievements))
    if data.social_links is not None:
        sets.append(f"social_links = ${len(args)+1}::jsonb"); args.append(json.dumps(data.social_links))

    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    args.append(int(client["sub"]))
    row = await db.fetchrow(
        f"""UPDATE clients SET {', '.join(sets)}
            WHERE id = ${len(args)}
            RETURNING id, brand_name, bio, profile_photo_url, positioning,
                      achievements, social_links""",
        *args
    )
    d = dict(row)
    d["achievements"] = _parse_jsonb(d.get("achievements"), [])
    d["social_links"] = _parse_jsonb(d.get("social_links"), {})
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
