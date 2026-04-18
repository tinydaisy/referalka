from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
import asyncpg
import re

router = APIRouter(prefix="/events", tags=["События"])


def slugify(title: str) -> str:
    slug = title.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_-]+", "-", slug)
    slug = slug[:50]
    return slug


class CreateEventRequest(BaseModel):
    title: str
    description: Optional[str] = None
    landing_url: Optional[str] = None
    webhook_url: Optional[str] = None
    module_slug: str = "base"
    points_free: int = 1
    points_paid: int = 0
    require_subscription: bool = False


class UpdateEventRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    landing_url: Optional[str] = None
    webhook_url: Optional[str] = None
    status: Optional[str] = None
    points_free: Optional[int] = None
    points_paid: Optional[int] = None
    require_subscription: Optional[bool] = None
    poster_url: Optional[str] = None


@router.get("/", summary="Список событий клиента")
async def list_events(
    module_slug: str = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    if module_slug:
        events = await db.fetch(
            """
            SELECT e.id, e.slug, e.title, e.module_slug, e.status, e.poster_url,
                   e.points_free, e.points_paid, e.created_at,
                   COUNT(DISTINCT ep.id) as participants_count
            FROM events e
            LEFT JOIN event_participants ep ON ep.event_id = e.id
            WHERE e.client_id = $1 AND e.module_slug = $2
            GROUP BY e.id
            ORDER BY e.created_at DESC
            """,
            client_id, module_slug
        )
    else:
        events = await db.fetch(
            """
            SELECT e.id, e.slug, e.title, e.module_slug, e.status, e.poster_url,
                   e.points_free, e.points_paid, e.created_at,
                   COUNT(DISTINCT ep.id) as participants_count
            FROM events e
            LEFT JOIN event_participants ep ON ep.event_id = e.id
            WHERE e.client_id = $1
            GROUP BY e.id
            ORDER BY e.created_at DESC
            """,
            client_id
        )
    return {"events": [dict(e) for e in events]}


@router.post("/", summary="Создать событие")
async def create_event(
    data: CreateEventRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    base_slug = slugify(data.title)
    slug = base_slug

    # Делаем slug уникальным
    counter = 1
    while await db.fetchrow("SELECT id FROM events WHERE slug = $1", slug):
        slug = f"{base_slug}-{counter}"
        counter += 1

    event = await db.fetchrow(
        """
        INSERT INTO events (client_id, slug, title, description, landing_url, webhook_url,
                            module_slug, points_free, points_paid, require_subscription)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
        """,
        client_id, slug, data.title, data.description, data.landing_url, data.webhook_url,
        data.module_slug, data.points_free, data.points_paid, data.require_subscription
    )

    # Если модуль — конференция, создаём запись в conf_conferences
    if data.module_slug == "conference":
        await db.execute(
            "INSERT INTO conf_conferences (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
            event["id"]
        )

    return {"event": dict(event)}


@router.get("/slug/{slug}", summary="Получить событие по slug")
async def get_event_by_slug(slug: str, db: asyncpg.Connection = Depends(get_db)):
    event = await db.fetchrow("SELECT * FROM events WHERE slug = $1", slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"event": dict(event)}


@router.get("/{event_id}", summary="Получить событие по ID")
async def get_event(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        "SELECT * FROM events WHERE id = $1 AND client_id = $2",
        event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"event": dict(event)}


@router.patch("/{event_id}", summary="Обновить событие")
async def update_event(
    event_id: int,
    data: UpdateEventRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="Нечего обновлять")

    set_parts = [f"{k} = ${i+2}" for i, k in enumerate(updates.keys())]
    values = list(updates.values())
    await db.execute(
        f"UPDATE events SET {', '.join(set_parts)} WHERE id = $1",
        event_id, *values
    )
    updated = await db.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
    return {"event": dict(updated)}


@router.delete("/{event_id}", summary="Удалить событие")
async def delete_event(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    result = await db.execute(
        "DELETE FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"message": "Событие удалено"}


@router.get("/{event_id}/analytics", summary="Аналитика события")
async def event_analytics(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    stats = await db.fetchrow(
        """
        SELECT
          COUNT(DISTINCT ep.id) as participants_total,
          COUNT(DISTINCT re.id) FILTER (WHERE re.type = 'click') as clicks_total,
          COUNT(DISTINCT re.id) FILTER (WHERE re.type = 'free') as conversions_free,
          COUNT(DISTINCT re.id) FILTER (WHERE re.type = 'paid') as conversions_paid,
          COUNT(DISTINCT gi.id) as gifts_issued
        FROM events e
        LEFT JOIN event_participants ep ON ep.event_id = e.id
        LEFT JOIN referral_events re ON re.event_id = e.id
        LEFT JOIN gift_issuances gi ON gi.participant_id = ep.id AND gi.status = 'issued'
        WHERE e.id = $1
        """,
        event_id
    )

    # Топ рефереров
    top = await db.fetch(
        """
        SELECT ep.ref_code, tu.first_name, tu.username,
               COUNT(re.id) as referrals_count, ep.points_total
        FROM event_participants ep
        JOIN telegram_users tu ON tu.tg_id = ep.tg_user_id
        LEFT JOIN referral_events re ON re.ref_code = ep.ref_code AND re.type IN ('free','paid')
        WHERE ep.event_id = $1
        GROUP BY ep.id, tu.first_name, tu.username
        ORDER BY referrals_count DESC
        LIMIT 10
        """,
        event_id
    )

    return {
        **dict(stats),
        "top_referrers": [dict(r) for r in top]
    }


@router.get("/{event_id}/participants", summary="Список участников события")
async def event_participants(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")

    rows = await db.fetch(
        """SELECT ep.id, ep.tg_user_id, ep.ref_code, ep.points_total, ep.registered_at,
                  tu.first_name, tu.last_name, tu.username,
                  COUNT(re.id) FILTER (WHERE re.type IN ('free','paid')) as referral_count
           FROM event_participants ep
           JOIN telegram_users tu ON tu.tg_id = ep.tg_user_id
           LEFT JOIN referral_events re ON re.ref_code = ep.ref_code AND re.event_id = ep.event_id
           WHERE ep.event_id = $1
           GROUP BY ep.id, tu.first_name, tu.last_name, tu.username
           ORDER BY ep.registered_at DESC""",
        event_id
    )
    return {"participants": [dict(r) for r in rows]}
