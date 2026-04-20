from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.database import get_db
from app.services.referral_engine import generate_ref_code
import asyncpg
import secrets
import string

router = APIRouter(prefix="/participants", tags=["Участники"])


class RegisterParticipantRequest(BaseModel):
    event_slug: str
    tg_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    ref_code: Optional[str] = None
    partner_tg_id: Optional[str] = None


async def get_unique_ref_code(db: asyncpg.Connection) -> str:
    alphabet = string.ascii_lowercase + string.digits
    for _ in range(10):
        code = "".join(secrets.choice(alphabet) for _ in range(8))
        exists = await db.fetchval("SELECT 1 FROM event_participants WHERE ref_code = $1", code)
        if not exists:
            return code
    raise HTTPException(status_code=500, detail="Не удалось сгенерировать ref_code")


@router.post("/register", summary="Зарегистрировать участника в событии")
async def register_participant(
    data: RegisterParticipantRequest,
    db: asyncpg.Connection = Depends(get_db)
):
    event = await db.fetchrow(
        "SELECT id, client_id FROM events WHERE slug = $1 AND status = 'active'",
        data.event_slug
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено или не активно")

    # Upsert в platform_users (telegram, привязка к client_id события)
    platform_user_id = await db.fetchval(
        """
        INSERT INTO platform_users (client_id, platform, platform_user_id, username, first_name, last_name)
        VALUES ($1, 'telegram', $2, $3, $4, $5)
        ON CONFLICT (client_id, platform, platform_user_id) DO UPDATE SET
          username   = COALESCE(EXCLUDED.username, platform_users.username),
          first_name = COALESCE(EXCLUDED.first_name, platform_users.first_name),
          last_name  = COALESCE(EXCLUDED.last_name, platform_users.last_name),
          updated_at = NOW()
        RETURNING id
        """,
        event["client_id"], str(data.tg_id), data.username, data.first_name, data.last_name
    )

    existing = await db.fetchrow(
        "SELECT id, ref_code, status FROM event_participants WHERE event_id=$1 AND platform_user_id=$2",
        event["id"], platform_user_id
    )
    if existing:
        return {"participant": dict(existing), "is_new": False}

    referrer_id = None
    resolved_ref_code = data.ref_code

    # Если передан partner_tg_id — ищем ref_code рефовода по tg_id
    if data.partner_tg_id and not resolved_ref_code:
        # 1) Сначала смотрим среди коллабораторов/спикеров этого события
        speaker_row = await db.fetchrow(
            """
            SELECT cse.ref_code FROM conf_speaker_events cse
            JOIN collaborators c ON c.id = cse.speaker_id
            WHERE c.personal_tg_id = $1 AND cse.event_id = $2
            """,
            str(data.partner_tg_id), event["id"]
        )
        if speaker_row and speaker_row["ref_code"]:
            resolved_ref_code = speaker_row["ref_code"]
        else:
            # 2) Иначе — среди участников события
            participant_row = await db.fetchrow(
                """
                SELECT ep.ref_code FROM event_participants ep
                JOIN platform_users pu ON pu.id = ep.platform_user_id
                WHERE pu.platform_user_id = $1 AND ep.event_id = $2
                """,
                str(data.partner_tg_id), event["id"]
            )
            if participant_row:
                resolved_ref_code = participant_row["ref_code"]

    if resolved_ref_code:
        referrer = await db.fetchrow(
            "SELECT id FROM event_participants WHERE ref_code = $1 AND event_id = $2",
            resolved_ref_code, event["id"]
        )
        if referrer:
            referrer_id = referrer["id"]

    new_code = await get_unique_ref_code(db)

    participant = await db.fetchrow(
        """
        INSERT INTO event_participants
          (event_id, platform_user_id, referrer_participant_id, ref_code, status)
        VALUES ($1,$2,$3,$4,'interested')
        RETURNING id, ref_code, status
        """,
        event["id"], platform_user_id, referrer_id, new_code
    )

    return {"participant": dict(participant), "is_new": True}


@router.post("/{participant_id}/activate", summary="Активировать участника")
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
               ep.id as participant_id, ep.ref_code, ep.status as participant_status
        FROM event_participants ep
        JOIN events e ON e.id = ep.event_id
        JOIN platform_users pu ON pu.id = ep.platform_user_id
        WHERE pu.platform = 'telegram' AND pu.platform_user_id = $1
        ORDER BY ep.registered_at DESC
        """,
        str(tg_id)
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
        SELECT ep.id, ep.ref_code, ep.status, ep.registered_at, ep.activated_at,
               e.title as event_title, e.module_slug
        FROM event_participants ep
        JOIN events e ON e.id = ep.event_id
        JOIN platform_users pu ON pu.id = ep.platform_user_id
        WHERE e.slug = $1 AND pu.platform = 'telegram' AND pu.platform_user_id = $2
        """,
        event_slug, str(tg_id)
    )
    if not row:
        raise HTTPException(status_code=404, detail="Участник не найден")

    referrals = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE referrer_participant_id = $1",
        row["id"]
    )

    return {"participant": dict(row), "referrals_count": referrals}
