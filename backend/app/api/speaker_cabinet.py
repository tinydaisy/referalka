"""
Мини-кабинет спикера на pluson.ru/speaker/<event_slug> — самообслуживание.

Не Mini App, отдельный веб-лендинг. Спикер открывает ссылку, выбирает свою
фамилию из списка, вводит код доступа (`collaborators.access_code`) — получает
сессионный токен (JWT 24ч) — правит свои данные.

Endpoints:
- GET  /api/v1/public/speaker-cabinet/{event_slug}/speakers — список фамилий
- POST /api/v1/public/speaker-cabinet/{event_slug}/auth     — выдача JWT
- GET  /api/v1/public/speaker-cabinet/me                    — данные после auth
- PATCH /api/v1/public/speaker-cabinet/me                   — правка профиля и события
- POST /api/v1/public/speaker-cabinet/me/photo              — заглушка для upload (через основной /uploads)
"""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
import asyncpg
import jwt

from app.config import settings
from app.database import get_db

router = APIRouter(prefix="/api/v1/public/speaker-cabinet", tags=["Кабинет спикера"])

_CAB_AUD = "speaker-cabinet"
_CAB_TTL_HOURS = 24


def _sign(speaker_event_id: int, collaborator_id: int, event_id: int) -> str:
    payload = {
        "aud": _CAB_AUD,
        "se_id": speaker_event_id,
        "c_id": collaborator_id,
        "e_id": event_id,
        "exp": datetime.now(timezone.utc) + timedelta(hours=_CAB_TTL_HOURS),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def _decode(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], audience=_CAB_AUD)
    except jwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"Сессия истекла или невалидна ({e})")


def _split_full_name(name: str) -> tuple[str, str]:
    s = (name or "").strip()
    if not s:
        return "", ""
    parts = s.split(maxsplit=1)
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[1]


@router.get("/{event_slug}/speakers", summary="Список фамилий спикеров события (публично)")
async def list_speakers_for_login(event_slug: str, db: asyncpg.Connection = Depends(get_db)):
    """Отдаёт только id+фамилия+имя — достаточно для выбора в выпадающем списке.
    Без access_code в ответе — это публичный endpoint."""
    ev = await db.fetchrow(
        "SELECT id, title FROM events WHERE slug = $1", event_slug
    )
    if not ev:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    rows = await db.fetch(
        """SELECT cse.id AS speaker_event_id, c.id AS collaborator_id, c.name
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cse.event_id = $1
            ORDER BY c.name""",
        ev["id"]
    )
    items = []
    for r in rows:
        first, last = _split_full_name(r["name"])
        items.append({
            "speaker_event_id": r["speaker_event_id"],
            "collaborator_id": r["collaborator_id"],
            "first_name": first,
            "last_name": last,
            "full_name": r["name"],
        })
    return {
        "event_id": ev["id"],
        "event_slug": event_slug,
        "event_title": ev["title"],
        "speakers": items,
    }


class CabinetAuthIn(BaseModel):
    speaker_event_id: int
    access_code: str


@router.post("/{event_slug}/auth", summary="Авторизация: фамилия + код доступа → JWT")
async def auth(event_slug: str, data: CabinetAuthIn, db: asyncpg.Connection = Depends(get_db)):
    code = (data.access_code or "").strip()
    if not code:
        raise HTTPException(status_code=422, detail="Введите код доступа")
    row = await db.fetchrow(
        """SELECT cse.id AS se_id, cse.event_id, c.id AS c_id, c.access_code
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             JOIN events e ON e.id = cse.event_id
            WHERE cse.id = $1 AND e.slug = $2""",
        data.speaker_event_id, event_slug
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден в этом событии")
    if (row["access_code"] or "").strip().lower() != code.lower():
        raise HTTPException(status_code=403, detail="Неверный код доступа")
    token = _sign(row["se_id"], row["c_id"], row["event_id"])
    return {"token": token, "expires_in_hours": _CAB_TTL_HOURS}


def _auth_session(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Нет токена сессии")
    token = authorization.split(" ", 1)[1].strip()
    return _decode(token)


@router.get("/me", summary="Профиль спикера (после авторизации)")
async def get_me(
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    se_id = int(session["se_id"])
    row = await db.fetchrow(
        """SELECT cse.id AS speaker_event_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  cse.show_topic_field, cse.show_gift_after_speech_field,
                  cse.show_knowledge_base_field,
                  c.id AS collaborator_id, c.name, c.title, c.achievements,
                  c.photo_url, c.poster_url, c.photo_folder_url, c.video_folder_url,
                  c.tg_channel_url, c.vk_url, c.max_url, c.instagram_url, c.website_url,
                  c.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username AS personal_tg_username,
                  pu_vk.platform_user_id AS personal_vk_id,
                  pu_vk.username AS personal_vk_username,
                  pu_max.platform_user_id AS personal_max_id,
                  pu_max.username AS personal_max_username,
                  ctc.email, ctc.phone,
                  e.title AS event_title, e.slug AS event_slug,
                  ers.is_enabled AS raffle_enabled
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             JOIN events e ON e.id = cse.event_id
             LEFT JOIN contacts ctc ON ctc.id = c.contact_id
             LEFT JOIN platform_users pu_tg
               ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
             LEFT JOIN platform_users pu_vk
               ON pu_vk.contact_id = c.contact_id AND pu_vk.platform_slug = 'vk'
             LEFT JOIN platform_users pu_max
               ON pu_max.contact_id = c.contact_id AND pu_max.platform_slug = 'max'
             LEFT JOIN event_raffle_settings ers ON ers.event_id = cse.event_id
            WHERE cse.id = $1""",
        se_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден (возможно, удалён)")
    topics = await db.fetch(
        "SELECT topic FROM conf_speaker_topics WHERE cse_id = $1 ORDER BY sort_order, id",
        se_id
    )
    d = dict(row)
    d["topics"] = [t["topic"] for t in topics if t["topic"]]
    return d


class CabinetUpdate(BaseModel):
    # Профиль (collaborators)
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    # Контакт (contacts)
    email: Optional[str] = None
    phone: Optional[str] = None
    # Личные идентичности
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    # Выступление (event_collaborators)
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None


@router.patch("/me", summary="Сохранить правки спикера")
async def patch_me(
    data: CabinetUpdate,
    session: dict = Depends(_auth_session),
    db: asyncpg.Connection = Depends(get_db),
):
    from app.api.collaborators import _upsert_personal_identities

    se_id = int(session["se_id"])
    c_id = int(session["c_id"])

    coll = await db.fetchrow(
        "SELECT created_by_client_id, contact_id FROM collaborators WHERE id = $1",
        c_id
    )
    if not coll:
        raise HTTPException(status_code=404, detail="Профиль не найден")
    client_id = coll["created_by_client_id"]
    contact_id = coll["contact_id"]

    # 1. Профиль (collaborators)
    profile_fields = ["name", "title", "achievements", "photo_url", "poster_url",
                      "tg_channel_url", "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id"]
    upd = {f: getattr(data, f) for f in profile_fields if getattr(data, f) is not None}
    if upd:
        parts = [f"{k} = ${i+2}" for i, k in enumerate(upd.keys())]
        parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(parts)} WHERE id = $1",
            c_id, *upd.values()
        )

    # 2. Контакт (contacts) — email / phone
    if contact_id:
        ct_upd = {}
        if data.email is not None:
            ct_upd["email"] = data.email.strip() or None
            ct_upd["email_normalized"] = (data.email or "").strip().lower() or None
        if data.phone is not None:
            phone_raw = (data.phone or "").strip()
            phone_norm = "".join(ch for ch in phone_raw if ch.isdigit()) or None
            if phone_norm and phone_norm.startswith("8") and len(phone_norm) == 11:
                phone_norm = "+7" + phone_norm[1:]
            ct_upd["phone"] = phone_raw or None
            ct_upd["phone_normalized"] = phone_norm
        if ct_upd:
            parts = [f"{k} = ${i+2}" for i, k in enumerate(ct_upd.keys())]
            await db.execute(
                f"UPDATE contacts SET {', '.join(parts)} WHERE id = $1",
                contact_id, *ct_upd.values()
            )

    # 3. Личные идентичности → platform_users
    if contact_id:
        await _upsert_personal_identities(db, client_id, contact_id, data)

    # 4. Темы выступления — переписываем целиком из массива
    if data.topics is not None:
        clean = [t.strip() for t in data.topics if (t or "").strip()]
        await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id = $1", se_id)
        if clean:
            for i, topic in enumerate(clean):
                await db.execute(
                    "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1,$2,$3)",
                    se_id, topic, i
                )
            await db.execute(
                "UPDATE event_collaborators SET speaker_topic = $1 WHERE id = $2",
                clean[0], se_id
            )
        else:
            await db.execute(
                "UPDATE event_collaborators SET speaker_topic = NULL WHERE id = $1", se_id
            )

    # 5. Подарки и материал
    ev_upd = {}
    for f in ("gift_after_speech_title", "gift_after_speech_url",
              "gift_raffle_title", "gift_raffle_url",
              "knowledge_base_title", "knowledge_base_url"):
        v = getattr(data, f, None)
        if v is not None:
            ev_upd[f] = v
    if ev_upd:
        parts = [f"{k} = ${i+2}" for i, k in enumerate(ev_upd.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(parts)} WHERE id = $1",
            se_id, *ev_upd.values()
        )

    return await get_me(session, db)
