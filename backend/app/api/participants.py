"""
API регистрации участников события (миграция 036+).

Использует helper `upsert_contact_with_identity` — автомердж по email/phone
и единая точка входа контакта в систему.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import asyncpg

from app.database import get_db
from app.services.contact_merge import upsert_contact_with_identity

router = APIRouter(prefix="/participants", tags=["Участники"])


class RegisterParticipantRequest(BaseModel):
    event_slug: str
    tg_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    ref_code: Optional[str] = None
    partner_tg_id: Optional[str] = None


@router.post("/register", summary="Зарегистрировать участника в событии")
async def register_participant(
    data: RegisterParticipantRequest,
    db: asyncpg.Connection = Depends(get_db)
):
    event = await db.fetchrow(
        "SELECT id, client_id FROM events WHERE slug = $1 AND status = 'published'",
        data.event_slug
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено или не опубликовано")

    # Создаём/находим контакт + идентичность (автомердж по email/phone)
    contact_id, _platform_user_id, _is_new_contact = await upsert_contact_with_identity(
        db,
        client_id=event["client_id"],
        platform_slug='telegram',
        platform_user_id=str(data.tg_id),
        username=data.username,
        first_name=data.first_name,
        last_name=data.last_name,
        email=data.email,
        phone=data.phone,
    )

    # Уже зарегистрирован?
    existing = await db.fetchrow(
        """SELECT ep.id, c.ref_code
             FROM event_participants ep
             JOIN contacts c ON c.id = ep.contact_id
            WHERE ep.event_id = $1 AND ep.contact_id = $2""",
        event["id"], contact_id
    )
    if existing:
        return {"participant": dict(existing), "is_new": False}

    # Резолв реферера: если передан ref_code — берём, иначе через partner_tg_id
    resolved_ref_code = data.ref_code
    if not resolved_ref_code and data.partner_tg_id:
        partner_code = await db.fetchval(
            """SELECT c.ref_code
                 FROM platform_users pu
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE pu.client_id = $1 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $2""",
            event["client_id"], str(data.partner_tg_id)
        )
        if partner_code:
            resolved_ref_code = partner_code

    # Если контакт-реферер тоже участник этого события — связываем
    referrer_participant_id = None
    if resolved_ref_code:
        referrer_participant_id = await db.fetchval(
            """SELECT ep.id
                 FROM contacts c
                 JOIN event_participants ep ON ep.contact_id = c.id
                WHERE c.ref_code = $1 AND ep.event_id = $2""",
            resolved_ref_code, event["id"]
        )

    # ref_code контакта (уже создан в upsert_contact_with_identity, но получим для ответа)
    user_ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", contact_id)

    participant = await db.fetchrow(
        """INSERT INTO event_participants
              (event_id, contact_id, referrer_participant_id, referrer_ref_code)
            VALUES ($1, $2, $3, $4)
         RETURNING id""",
        event["id"], contact_id, referrer_participant_id, resolved_ref_code
    )

    return {
        "participant": {"id": participant["id"], "ref_code": user_ref_code},
        "is_new": True
    }


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
        """SELECT e.id, e.slug, e.title, e.module_slug, e.status, e.poster_url,
                  ep.id AS participant_id, c.ref_code, ep.is_registered, ep.is_in_chat
             FROM event_participants ep
             JOIN events e ON e.id = ep.event_id
             JOIN contacts c ON c.id = ep.contact_id
             JOIN platform_users pu ON pu.contact_id = c.id
            WHERE pu.platform_slug = 'telegram' AND pu.platform_user_id = $1
            ORDER BY ep.registered_at DESC""",
        str(tg_id)
    )
    return {"events": [dict(r) for r in rows]}


@router.get(
    "/miniapp/me/events",
    summary="События участника для селектора Mini App (с организатором, группировкой now/soon/past)",
)
async def get_miniapp_me_events(tg_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT e.id, e.slug, e.title, e.module_slug, e.status, e.poster_url,
                  e.start_at, e.end_at,
                  ep.id AS participant_id, c.ref_code, ep.is_registered, ep.is_in_chat,
                  cl.id   AS client_id,
                  cl.name AS client_name,
                  cl.brand_name        AS client_brand_name,
                  cl.profile_photo_url AS client_photo_url,
                  cl.positioning       AS client_positioning
             FROM event_participants ep
             JOIN events e   ON e.id  = ep.event_id
             JOIN clients cl ON cl.id = e.client_id
             JOIN contacts c ON c.id  = ep.contact_id
             JOIN platform_users pu ON pu.contact_id = c.id
            WHERE pu.platform_slug = 'telegram' AND pu.platform_user_id = $1
            ORDER BY COALESCE(e.start_at, e.created_at) ASC""",
        str(tg_id),
    )

    now_list, soon_list, past_list = [], [], []
    from datetime import datetime, timezone
    now_ts = datetime.now(timezone.utc)

    for r in rows:
        item = dict(r)
        # ISO-формат для фронта
        if item.get("start_at"): item["start_at"] = item["start_at"].isoformat()
        if item.get("end_at"):   item["end_at"]   = item["end_at"].isoformat()

        start = r["start_at"]
        end   = r["end_at"]
        status = (r["status"] or "").lower()

        is_live = status == "live" or (start and end and start <= now_ts <= end)
        is_past = status in ("archived", "ended", "completed") or (end and end < now_ts)

        if is_live:
            now_list.append(item)
        elif is_past:
            past_list.append(item)
        else:
            soon_list.append(item)

    # past — самые свежие сверху
    past_list.sort(key=lambda x: x.get("end_at") or "", reverse=True)

    return {"now": now_list, "soon": soon_list, "past": past_list}


@router.get("/event/{event_slug}/user/{tg_id}", summary="Данные участника в событии")
async def get_participant_in_event(
    event_slug: str,
    tg_id: int,
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """SELECT ep.id, c.ref_code, ep.is_registered, ep.is_in_chat, ep.registered_at, ep.activated_at,
                  e.title AS event_title, e.module_slug
             FROM event_participants ep
             JOIN events e ON e.id = ep.event_id
             JOIN contacts c ON c.id = ep.contact_id
             JOIN platform_users pu ON pu.contact_id = c.id
            WHERE e.slug = $1 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $2
            LIMIT 1""",
        event_slug, str(tg_id)
    )
    if not row:
        raise HTTPException(status_code=404, detail="Участник не найден")

    referrals = await db.fetchval(
        "SELECT COUNT(*) FROM event_participants WHERE referrer_participant_id = $1",
        row["id"]
    )

    return {"participant": dict(row), "referrals_count": referrals}
