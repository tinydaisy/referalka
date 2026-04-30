from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/events/{event_id}/gifts", tags=["Подарки"])

# Совместимый роутер для старого URL /api/v1/events/slug/{slug}/gifts/
# НЕ УДАЛЯТЬ — на этот маршрут завязан Mini App
router_compat = APIRouter(prefix="/events/slug", tags=["Подарки"])


class GiftCreate(BaseModel):
    title: str
    description: Optional[str] = None
    points_cost: int
    link_url: Optional[str] = None
    stock: int = -1
    sort_order: int = 0


async def check_event_owner(event_id: int, client_id: int, db: asyncpg.Connection):
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return event


@router.get("/", summary="Подарки события")
async def list_gifts(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    gifts = await db.fetch(
        "SELECT * FROM gifts WHERE event_id = $1 ORDER BY sort_order, points_cost",
        event_id
    )
    return {"gifts": [dict(g) for g in gifts]}


@router.post("/", summary="Добавить подарок")
async def create_gift(
    event_id: int,
    data: GiftCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    gift = await db.fetchrow(
        """
        INSERT INTO gifts (event_id, title, description, points_cost, link_url, stock, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
        """,
        event_id, data.title, data.description, data.points_cost,
        data.link_url, data.stock, data.sort_order
    )
    return {"gift": dict(gift)}


@router.patch("/{gift_id}", summary="Обновить подарок")
async def update_gift(
    event_id: int,
    gift_id: int,
    data: GiftCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    gift = await db.fetchrow(
        """
        UPDATE gifts SET title=$2, description=$3, points_cost=$4, link_url=$5, stock=$6, sort_order=$7
        WHERE id=$1 AND event_id=$8 RETURNING *
        """,
        gift_id, data.title, data.description, data.points_cost,
        data.link_url, data.stock, data.sort_order, event_id
    )
    if not gift:
        raise HTTPException(status_code=404, detail="Подарок не найден")
    return {"gift": dict(gift)}


@router.delete("/{gift_id}", summary="Удалить подарок")
async def delete_gift(
    event_id: int,
    gift_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_event_owner(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM gifts WHERE id = $1 AND event_id = $2", gift_id, event_id)
    return {"message": "Подарок удалён"}


async def _fetch_gifts_for_event(event_id: int, db: asyncpg.Connection):
    """
    Подарки реф-программы из event_referral_thresholds + JOIN lead_magnets.
    Возвращает список в формате, который ждёт Mini App (id, title, description,
    points_cost, link_url, sort_order).
    """
    rows = await db.fetch(
        """
        SELECT t.id,
               COALESCE(NULLIF(lm.name, ''), 'Подарок') AS title,
               lm.description                          AS description,
               t.threshold_count                       AS points_cost,
               lm.url                                  AS link_url,
               t.certificate_url                       AS certificate_url,
               t.sort                                  AS sort_order
          FROM event_referral_thresholds t
          LEFT JOIN lead_magnets lm ON lm.id = t.lead_magnet_id
         WHERE t.event_id = $1
         ORDER BY t.sort, t.threshold_count
        """,
        event_id,
    )
    return [dict(r) for r in rows]


@router.get("/public/{event_slug}", summary="Подарки для Mini App (публично)")
async def list_gifts_public(event_slug: str, db: asyncpg.Connection = Depends(get_db)):
    event = await db.fetchrow("SELECT id FROM events WHERE slug = $1", event_slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"gifts": await _fetch_gifts_for_event(event["id"], db)}


@router_compat.get("/{event_slug}/gifts/", summary="Подарки для Mini App — совместимый URL")
async def list_gifts_by_slug(event_slug: str, db: asyncpg.Connection = Depends(get_db)):
    event = await db.fetchrow("SELECT id FROM events WHERE slug = $1", event_slug)
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return {"gifts": await _fetch_gifts_for_event(event["id"], db)}
