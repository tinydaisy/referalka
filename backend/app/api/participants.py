from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.database import get_db
from app.services.referral_engine import generate_ref_code
import asyncpg

router = APIRouter(prefix="/participants", tags=["Участники"])


class RegisterParticipantRequest(BaseModel):
    event_slug: str
    tg_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    ref_code: Optional[str] = None          # реферальный код того, кто пригласил
    promo_partner_code: Optional[str] = None


@router.post("/register", summary="Зарегистрировать участника в событии")
async def register_participant(
    data: RegisterParticipantRequest,
    db: asyncpg.Connection = Depends(get_db)
):
    # Находим событие
    event = await db.fetchrow(
        "SELECT id, points_free, points_paid FROM events WHERE slug = $1 AND status = 'active'",
        data.event_slug
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено или не активно")

    # Upsert пользователя в telegram_users
    await db.execute(
        """
        INSERT INTO telegram_users (tg_id, username, first_name, last_name)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (tg_id) DO UPDATE SET
          username = EXCLUDED.username,
          first_name = EXCLUDED.first_name
        """,
        data.tg_id, data.username, data.first_name, data.last_name
    )

    # Проверяем, не участвует ли уже
    existing = await db.fetchrow(
        "SELECT id, ref_code, points_total FROM event_participants WHERE event_id=$1 AND tg_user_id=$2",
        event["id"], data.tg_id
    )
    if existing:
        return {"participant": dict(existing), "is_new": False}

    # Определяем referrer_participant_id
    referrer_id = None
    if data.ref_code:
        referrer = await db.fetchrow(
            "SELECT id FROM event_participants WHERE ref_code = $1 AND event_id = $2",
            data.ref_code, event["id"]
        )
        if referrer:
            referrer_id = referrer["id"]

    # Генерируем уникальный ref_code
    new_code = generate_ref_code()
    while await db.fetchrow("SELECT id FROM event_participants WHERE ref_code = $1", new_code):
        new_code = generate_ref_code()

    ref_code_paid = None
    if event["points_paid"] > 0:
        ref_code_paid = generate_ref_code("p")
        while await db.fetchrow("SELECT id FROM event_participants WHERE ref_code_paid = $1", ref_code_paid):
            ref_code_paid = generate_ref_code("p")

    participant = await db.fetchrow(
        """
        INSERT INTO event_participants
          (event_id, tg_user_id, referrer_participant_id, ref_code, ref_code_paid, promo_partner_code)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING *
        """,
        event["id"], data.tg_id, referrer_id, new_code, ref_code_paid, data.promo_partner_code
    )

    return {"participant": dict(participant), "is_new": True}


@router.post("/{participant_id}/activate", summary="Активировать участника (открыл Игру)")
async def activate_participant(participant_id: int, db: asyncpg.Connection = Depends(get_db)):
    await db.execute(
        "UPDATE event_participants SET activated_at = NOW() WHERE id = $1 AND activated_at IS NULL",
        participant_id
    )
    return {"activated": True}


@router.get("/telegram/{tg_id}/events", summary="События участника по tg_id")
async def get_participant_events(tg_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """
        SELECT e.id, e.slug, e.title, e.module_slug, e.status, e.poster_url,
               ep.id as participant_id, ep.ref_code, ep.points_total
        FROM event_participants ep
        JOIN events e ON e.id = ep.event_id
        WHERE ep.tg_user_id = $1
        ORDER BY ep.registered_at DESC
        """,
        tg_id
    )
    return {"events": [dict(r) for r in rows]}


@router.get("/event/{event_slug}/user/{tg_id}", summary="Данные участника в событии")
async def get_participant_in_event(
    event_slug: str,
    tg_id: int,
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """
        SELECT ep.*, e.points_free, e.points_paid, e.title as event_title, e.module_slug
        FROM event_participants ep
        JOIN events e ON e.id = ep.event_id
        WHERE e.slug = $1 AND ep.tg_user_id = $2
        """,
        event_slug, tg_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Участник не найден")

    # Кол-во рефералов
    referrals = await db.fetchrow(
        """
        SELECT COUNT(*) as count FROM event_participants
        WHERE referrer_participant_id = $1
        """,
        row["id"]
    )

    return {
        "participant": dict(row),
        "referrals_count": referrals["count"]
    }
