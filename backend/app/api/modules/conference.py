from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
import asyncpg
import re
import json
from datetime import datetime, date, time, timedelta

router = APIRouter(prefix="/events/{event_id}/conference", tags=["Конференция"])


def slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_-]+", "-", slug)
    return slug[:60]


async def check_conference_access(event_id: int, client_id: int, db: asyncpg.Connection):
    event = await db.fetchrow(
        "SELECT id, module_slug FROM events WHERE id = $1 AND client_id = $2",
        event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return event


async def regenerate_landing_data(event_id: int, db: asyncpg.Connection):
    """Собирает JSON-снимок конференции из БД и сохраняет в landing_data."""
    conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
    if not conf:
        return
    event = await db.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
    # Спикеры: JOIN глобальной базы + данных участия в событии
    speakers = await db.fetch(
        """SELECT cse.*, sp.name, sp.title, sp.company, sp.bio, sp.achievements,
                  sp.photo_url, sp.telegram_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse
           JOIN speakers sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1 AND cse.is_visible = TRUE
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    sessions = await db.fetch(
        """SELECT s.*, sp.name AS speaker_name, cse.role AS speaker_role,
                  sp.title AS speaker_title, sp.photo_url, cse.gift_title, cse.gift_url
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN speakers sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1 ORDER BY s.day, s.sort_order, s.start_datetime""",
        event_id
    )

    def dt_str(val):
        if val is None:
            return None
        if isinstance(val, (datetime,)):
            return val.strftime("%H:%M")
        return str(val)

    def date_str(val):
        if val is None:
            return None
        if isinstance(val, date):
            return val.strftime("%-d %B %Y года")
        return str(val)

    schedule = []
    for d in days:
        day_sessions = [s for s in sessions if s["day"] == d["day_number"]]
        schedule.append({
            "day": f"День {d['day_number']}",
            "date": date_str(d["day_date"]),
            "stream_url": d["stream_url"],
            "slots": [
                {
                    "time": dt_str(s["start_datetime"]),
                    "time_end": dt_str(s["end_datetime"]),
                    "title": s["title"],
                    "speaker": s["speaker_name"],
                    "speaker_role": s["speaker_role"],
                    "speaker_title": s["speaker_title"],
                    "photo_url": s["photo_url"],
                    "gift_title": s["gift_title"],
                    "gift_url": s["gift_url"],
                }
                for s in day_sessions
            ]
        })

    landing_data = {
        "id": event["slug"] if event else str(event_id),
        "name": event["title"] if event else "",
        "name_sub": conf["offer"] or "",
        "dates": f"{date_str(conf['start_date'])} — {date_str(conf['end_date'])}" if conf["start_date"] else "",
        "description": conf["description"] or "",
        "registration_url": conf["registration_url"] or conf["getcourse_form_url"] or "",
        "chat_url": conf["chat_url"] or "",
        "landing_template": conf["landing_template"] or "ivision",
        "speakers": [
            {
                "id": s["id"],
                "name": s["name"],
                "role": s["role"],
                "title": s["title"] or "",
                "company": s["company"] or "",
                "bio": s["bio"] or "",
                "photo_url": s["photo_url"] or "",
                "telegram_url": s["telegram_url"] or "",
                "speaker_topic": s["speaker_topic"] or "",
                "gift_title": s["gift_title"] or "",
                "gift_url": s["gift_url"] or "",
            }
            for s in speakers
        ],
        "schedule": schedule,
        "poster_horizontal": list(conf["poster_horizontal"] or []),
        "poster_vertical": list(conf["poster_vertical"] or []),
        "poster_square": list(conf["poster_square"] or []),
    }

    await db.execute(
        "UPDATE conf_conferences SET landing_data = $1 WHERE event_id = $2",
        json.dumps(landing_data), event_id
    )
    return landing_data


# ─── Конференция (настройки) ───────────────────────────────────────────────────

class ConferenceUpdate(BaseModel):
    subtitle: Optional[str] = None
    offer: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    registration_url: Optional[str] = None
    landing_url: Optional[str] = None
    landing_template: Optional[str] = None
    chat_url: Optional[str] = None
    getcourse_form_url: Optional[str] = None
    stream_url_day_1: Optional[str] = None
    stream_url_day_2: Optional[str] = None
    vip_upsell_url: Optional[str] = None
    require_speakers_sub: Optional[bool] = None
    is_live: Optional[bool] = None
    status: Optional[str] = None
    poster_horizontal: Optional[List[str]] = None
    poster_vertical: Optional[List[str]] = None
    poster_square: Optional[List[str]] = None


@router.get("/", summary="Данные конференции")
async def get_conference(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
    return {"conference": dict(conf) if conf else None}


@router.post("/init", summary="Инициализировать конференцию")
async def init_conference(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    existing = await db.fetchrow("SELECT id FROM conf_conferences WHERE event_id = $1", event_id)
    if existing:
        conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
        return {"conference": dict(conf)}
    conf = await db.fetchrow(
        "INSERT INTO conf_conferences (event_id) VALUES ($1) RETURNING *", event_id
    )
    return {"conference": dict(conf)}


@router.patch("/", summary="Обновить настройки конференции")
async def update_conference(
    event_id: int,
    data: ConferenceUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    # Создаём если не существует
    existing = await db.fetchrow("SELECT id FROM conf_conferences WHERE event_id = $1", event_id)
    if not existing:
        await db.execute("INSERT INTO conf_conferences (event_id) VALUES ($1)", event_id)

    updates = {}
    for k, v in data.model_dump().items():
        if v is not None:
            updates[k] = v

    if updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(updates.keys())]
        await db.execute(
            f"UPDATE conf_conferences SET {', '.join(set_parts)} WHERE event_id = $1",
            event_id, *updates.values()
        )

    await regenerate_landing_data(event_id, db)
    conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
    return {"conference": dict(conf)}


@router.post("/regenerate-landing", summary="Пересобрать JSON лендинга")
async def regenerate_landing(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    data = await regenerate_landing_data(event_id, db)
    return {"landing_data": data, "message": "JSON лендинга обновлён"}


# ─── Спикеры события (conf_speaker_events) ────────────────────────────────────
# Личные данные (фото, регалии, контакты) хранятся в таблице speakers (глобально).
# Здесь — только то, что специфично для конкретного события: роль, тема, подарок.

class SpeakerAddToEvent(BaseModel):
    """Добавить спикера из глобальной базы в событие."""
    speaker_id: int
    role: str = "speaker"
    speaker_topic: Optional[str] = None
    gift_title: Optional[str] = None
    gift_url: Optional[str] = None
    poster_url: Optional[str] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    is_visible: bool = True
    sort_order: int = 0


class SpeakerCreateAndAdd(BaseModel):
    """Создать нового спикера в базе и сразу добавить в событие."""
    # Глобальные данные спикера
    name: str
    title: Optional[str] = None
    company: Optional[str] = None
    bio: Optional[str] = None
    achievements: Optional[str] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    telegram_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    # Данные участия в этом событии
    role: str = "speaker"
    speaker_topic: Optional[str] = None
    gift_title: Optional[str] = None
    gift_url: Optional[str] = None
    poster_url: Optional[str] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    is_visible: bool = True
    sort_order: int = 0


class SpeakerEventUpdate(BaseModel):
    """Обновить данные участия спикера в событии (тема, подарок, роль и т.д.)"""
    role: Optional[str] = None
    speaker_topic: Optional[str] = None
    gift_title: Optional[str] = None
    gift_url: Optional[str] = None
    poster_url: Optional[str] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    is_visible: Optional[bool] = None
    sort_order: Optional[int] = None


def _speaker_row_to_dict(row) -> dict:
    """Объединяет данные из speakers + conf_speaker_events в один объект."""
    d = dict(row)
    return d


@router.get("/speakers", summary="Спикеры события")
async def list_event_speakers(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_title, cse.gift_url,
                  cse.poster_url, cse.partner_url, cse.extra_info,
                  cse.ref_code, cse.is_visible, cse.sort_order,
                  sp.name, sp.title, sp.company, sp.bio, sp.achievements,
                  sp.photo_url, sp.photo_folder_url, sp.video_folder_url,
                  sp.telegram_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse
           JOIN speakers sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    return {"speakers": [dict(r) for r in rows]}


@router.get("/speakers/public", summary="Спикеры для Mini App")
async def list_event_speakers_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT cse.id, cse.role, cse.speaker_topic, cse.gift_title, cse.gift_url, cse.sort_order,
                  sp.name, sp.title, sp.company, sp.bio, sp.photo_url, sp.telegram_url
           FROM conf_speaker_events cse
           JOIN speakers sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1 AND cse.is_visible = TRUE
           ORDER BY cse.sort_order""",
        event_id
    )
    return {"speakers": [dict(r) for r in rows]}


@router.post("/speakers/add-from-base", summary="Добавить спикера из базы в событие")
async def add_speaker_from_base(
    event_id: int,
    data: SpeakerAddToEvent,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    # Проверяем что спикер существует
    sp = await db.fetchrow("SELECT id FROM speakers WHERE id = $1", data.speaker_id)
    if not sp:
        raise HTTPException(status_code=404, detail="Спикер не найден в базе")
    # Проверяем что уже не добавлен
    existing = await db.fetchrow(
        "SELECT id FROM conf_speaker_events WHERE speaker_id = $1 AND event_id = $2",
        data.speaker_id, event_id
    )
    if existing:
        raise HTTPException(status_code=400, detail="Спикер уже добавлен в это событие")

    import random, string
    ref_code = "sp_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))

    cse = await db.fetchrow(
        """INSERT INTO conf_speaker_events
           (speaker_id, event_id, role, speaker_topic, gift_title, gift_url,
            poster_url, partner_url, extra_info, ref_code, is_visible, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *""",
        data.speaker_id, event_id, data.role, data.speaker_topic, data.gift_title,
        data.gift_url, data.poster_url, data.partner_url, data.extra_info,
        ref_code, data.is_visible, data.sort_order
    )
    # Возвращаем с данными из глобальной базы
    row = await db.fetchrow(
        """SELECT cse.*, sp.name, sp.title, sp.company, sp.bio, sp.achievements,
                  sp.photo_url, sp.photo_folder_url, sp.video_folder_url,
                  sp.telegram_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse JOIN speakers sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1""",
        cse["id"]
    )
    await regenerate_landing_data(event_id, db)
    return {"speaker": dict(row)}


@router.post("/speakers", summary="Создать нового спикера и добавить в событие")
async def create_and_add_speaker(
    event_id: int,
    data: SpeakerCreateAndAdd,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    # 1. Создаём в глобальной базе
    sp = await db.fetchrow(
        """INSERT INTO speakers
           (name, title, company, bio, achievements,
            photo_url, photo_folder_url, video_folder_url,
            telegram_url, instagram_url, website_url, created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *""",
        data.name, data.title, data.company, data.bio, data.achievements,
        data.photo_url, data.photo_folder_url, data.video_folder_url,
        data.telegram_url, data.instagram_url, data.website_url,
        int(client["sub"])
    )

    # 2. Добавляем в событие
    import random, string
    ref_code = "sp_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))

    cse = await db.fetchrow(
        """INSERT INTO conf_speaker_events
           (speaker_id, event_id, role, speaker_topic, gift_title, gift_url,
            poster_url, partner_url, extra_info, ref_code, is_visible, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *""",
        sp["id"], event_id, data.role, data.speaker_topic, data.gift_title,
        data.gift_url, data.poster_url, data.partner_url, data.extra_info,
        ref_code, data.is_visible, data.sort_order
    )

    result = {**dict(sp), **dict(cse), "speaker_id": sp["id"]}
    await regenerate_landing_data(event_id, db)
    return {"speaker": result}


@router.patch("/speakers/{speaker_event_id}", summary="Обновить участие спикера в событии")
async def update_speaker_event(
    event_id: int,
    speaker_event_id: int,
    data: SpeakerEventUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    updates = {k: v for k, v in data.model_dump().items() if v is not None}
    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        await db.execute(
            f"UPDATE conf_speaker_events SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2",
            speaker_event_id, event_id, *updates.values()
        )
    row = await db.fetchrow(
        """SELECT cse.*, sp.name, sp.title, sp.company, sp.bio, sp.achievements,
                  sp.photo_url, sp.photo_folder_url, sp.video_folder_url,
                  sp.telegram_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse JOIN speakers sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1""",
        speaker_event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден в событии")
    await regenerate_landing_data(event_id, db)
    return {"speaker": dict(row)}


@router.delete("/speakers/{speaker_event_id}", summary="Убрать спикера из события")
async def remove_speaker_from_event(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    await db.execute(
        "DELETE FROM conf_speaker_events WHERE id = $1 AND event_id = $2",
        speaker_event_id, event_id
    )
    await regenerate_landing_data(event_id, db)
    return {"message": "Спикер убран из события (остался в базе)"}


# ─── Дни конференции ──────────────────────────────────────────────────────────

class DayUpdate(BaseModel):
    day_date: Optional[str] = None
    open_time: Optional[str] = None
    close_time: Optional[str] = None
    stream_url: Optional[str] = None


@router.get("/days", summary="Дни конференции")
async def list_days(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    return {"days": [dict(d) for d in days]}


@router.put("/days/{day_number}", summary="Сохранить день")
async def upsert_day(
    event_id: int,
    day_number: int,
    data: DayUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    day_date = date.fromisoformat(data.day_date) if data.day_date else None
    open_time = time.fromisoformat(data.open_time) if data.open_time else None
    close_time = time.fromisoformat(data.close_time) if data.close_time else None

    day = await db.fetchrow(
        """INSERT INTO conf_days (event_id, day_number, day_date, open_time, close_time, stream_url)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (event_id, day_number) DO UPDATE
             SET day_date=$3, open_time=$4, close_time=$5, stream_url=$6
           RETURNING *""",
        event_id, day_number, day_date, open_time, close_time, data.stream_url
    )
    await regenerate_landing_data(event_id, db)
    return {"day": dict(day)}


# ─── Сессии ───────────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    speaker_id: Optional[int] = None
    day: int
    start_datetime: Optional[str] = None
    end_datetime: Optional[str] = None
    title: str
    gift_description: Optional[str] = None
    stream_url: Optional[str] = None
    track_label: Optional[str] = None
    track_color: Optional[str] = None
    sort_order: int = 0


class SessionUpdate(BaseModel):
    speaker_id: Optional[int] = None
    day: Optional[int] = None
    start_datetime: Optional[str] = None
    end_datetime: Optional[str] = None
    title: Optional[str] = None
    gift_description: Optional[str] = None
    stream_url: Optional[str] = None
    sort_order: Optional[int] = None


class ScheduleGenerateRequest(BaseModel):
    day: int
    start_time: str          # "11:00"
    slot_duration: int = 30  # минут
    break_duration: int = 10 # минут
    speaker_ids: List[int]   # в порядке выступления


@router.get("/sessions", summary="Все сессии")
async def list_sessions(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    sessions = await db.fetch(
        """SELECT s.*, sp.name as speaker_name, sp.title as speaker_title,
                  sp.photo_url, sp.role as speaker_role
           FROM conf_sessions s
           LEFT JOIN conf_speakers sp ON sp.id = s.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, s.sort_order, s.start_datetime""",
        event_id
    )
    return {"sessions": [dict(s) for s in sessions]}


@router.get("/sessions/day/{day}", summary="Сессии по дню (для Mini App)")
async def get_sessions_by_day(event_id: int, day: int, db: asyncpg.Connection = Depends(get_db)):
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.start_datetime, s.end_datetime, s.title,
                  s.gift_description, s.stream_url, s.track_label, s.track_color,
                  sp.name as speaker_name, sp.title as speaker_title,
                  sp.photo_url, sp.company, sp.gift_title, sp.gift_url
           FROM conf_sessions s
           LEFT JOIN conf_speakers sp ON sp.id = s.speaker_id
           WHERE s.event_id = $1 AND s.day = $2
           ORDER BY s.sort_order, s.start_datetime""",
        event_id, day
    )
    return {"sessions": [dict(s) for s in sessions], "day": day}


@router.post("/sessions", summary="Добавить сессию")
async def create_session(
    event_id: int,
    data: SessionCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    start_dt = datetime.fromisoformat(data.start_datetime) if data.start_datetime else None
    end_dt = datetime.fromisoformat(data.end_datetime) if data.end_datetime else None
    session = await db.fetchrow(
        """INSERT INTO conf_sessions
          (event_id, speaker_id, day, start_datetime, end_datetime, title,
           gift_description, stream_url, track_label, track_color, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *""",
        event_id, data.speaker_id, data.day, start_dt, end_dt, data.title,
        data.gift_description, data.stream_url, data.track_label, data.track_color, data.sort_order
    )
    await regenerate_landing_data(event_id, db)
    return {"session": dict(session)}


@router.patch("/sessions/{session_id}", summary="Обновить сессию")
async def update_session(
    event_id: int,
    session_id: int,
    data: SessionUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    updates = {}
    for k, v in data.model_dump().items():
        if v is not None:
            if k in ("start_datetime", "end_datetime") and v:
                updates[k] = datetime.fromisoformat(v)
            else:
                updates[k] = v
    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        session = await db.fetchrow(
            f"UPDATE conf_sessions SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2 RETURNING *",
            session_id, event_id, *updates.values()
        )
        if not session:
            raise HTTPException(status_code=404, detail="Сессия не найдена")
    else:
        session = await db.fetchrow("SELECT * FROM conf_sessions WHERE id=$1", session_id)
    await regenerate_landing_data(event_id, db)
    return {"session": dict(session)}


@router.delete("/sessions/{session_id}", summary="Удалить сессию")
async def delete_session(
    event_id: int,
    session_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM conf_sessions WHERE id = $1 AND event_id = $2", session_id, event_id)
    await regenerate_landing_data(event_id, db)
    return {"message": "Сессия удалена"}


@router.post("/sessions/generate", summary="Сгенерировать расписание")
async def generate_schedule(
    event_id: int,
    data: ScheduleGenerateRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    # Получаем дату дня из conf_days
    day_row = await db.fetchrow(
        "SELECT day_date FROM conf_days WHERE event_id=$1 AND day_number=$2", event_id, data.day
    )
    base_date = day_row["day_date"] if day_row and day_row["day_date"] else date.today()

    # Удаляем старые сессии этого дня
    await db.execute(
        "DELETE FROM conf_sessions WHERE event_id=$1 AND day=$2", event_id, data.day
    )

    # Парсим время начала
    h, m = map(int, data.start_time.split(":"))
    current = datetime.combine(base_date, time(h, m))

    created = []
    for idx, speaker_event_id in enumerate(data.speaker_ids):
        # speaker_ids теперь — это conf_speaker_events.id
        cse = await db.fetchrow(
            """SELECT cse.id, sp.name FROM conf_speaker_events cse
               JOIN speakers sp ON sp.id = cse.speaker_id
               WHERE cse.id=$1 AND cse.event_id=$2""",
            speaker_event_id, event_id
        )
        if not cse:
            continue
        end_dt = current + timedelta(minutes=data.slot_duration)
        session = await db.fetchrow(
            """INSERT INTO conf_sessions
               (event_id, speaker_id, day, start_datetime, end_datetime, title, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
            event_id, speaker_event_id, data.day, current, end_dt,
            "Выступление", idx
        )
        created.append(dict(session))
        current = end_dt + timedelta(minutes=data.break_duration)

    await regenerate_landing_data(event_id, db)
    return {"sessions": created, "message": f"Создано {len(created)} сессий"}


# ─── Рассылки ─────────────────────────────────────────────────────────────────

class BroadcastCreate(BaseModel):
    session_id: Optional[int] = None
    speaker_id: Optional[int] = None
    type: str  # pre_5min|pre_30min|pre_1day|post_thanks|day_start|manual
    scheduled_at: Optional[str] = None
    text: str


class BroadcastUpdate(BaseModel):
    text: Optional[str] = None
    scheduled_at: Optional[str] = None
    status: Optional[str] = None


@router.get("/broadcasts", summary="Список рассылок")
async def list_broadcasts(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT b.*, sp.name as speaker_name, s.title as session_title,
                  s.start_datetime as session_time
           FROM conf_broadcast_messages b
           LEFT JOIN conf_speakers sp ON sp.id = b.speaker_id
           LEFT JOIN conf_sessions s ON s.id = b.session_id
           WHERE b.event_id = $1
           ORDER BY b.scheduled_at NULLS LAST, b.id""",
        event_id
    )
    return {"broadcasts": [dict(r) for r in rows]}


@router.post("/broadcasts", summary="Создать рассылку")
async def create_broadcast(
    event_id: int,
    data: BroadcastCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    scheduled = datetime.fromisoformat(data.scheduled_at) if data.scheduled_at else None
    row = await db.fetchrow(
        """INSERT INTO conf_broadcast_messages
           (event_id, session_id, speaker_id, type, scheduled_at, text, status)
           VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *""",
        event_id, data.session_id, data.speaker_id, data.type, scheduled, data.text
    )
    return {"broadcast": dict(row)}


@router.patch("/broadcasts/{broadcast_id}", summary="Обновить рассылку")
async def update_broadcast(
    event_id: int,
    broadcast_id: int,
    data: BroadcastUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    updates = {}
    if data.text is not None:
        updates["text"] = data.text
        updates["is_edited"] = True
    if data.scheduled_at is not None:
        updates["scheduled_at"] = datetime.fromisoformat(data.scheduled_at)
    if data.status is not None:
        updates["status"] = data.status

    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        row = await db.fetchrow(
            f"UPDATE conf_broadcast_messages SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2 RETURNING *",
            broadcast_id, event_id, *updates.values()
        )
        if not row:
            raise HTTPException(status_code=404, detail="Рассылка не найдена")
    else:
        row = await db.fetchrow("SELECT * FROM conf_broadcast_messages WHERE id=$1", broadcast_id)
    return {"broadcast": dict(row)}


@router.post("/broadcasts/{broadcast_id}/approve", summary="Утвердить рассылку")
async def approve_broadcast(
    event_id: int,
    broadcast_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    row = await db.fetchrow(
        """UPDATE conf_broadcast_messages
           SET status='approved', approved_at=NOW(), approved_by=$3
           WHERE id=$1 AND event_id=$2 RETURNING *""",
        broadcast_id, event_id, client.get("email", "client")
    )
    if not row:
        raise HTTPException(status_code=404, detail="Рассылка не найдена")
    return {"broadcast": dict(row), "message": "Рассылка утверждена и будет отправлена по расписанию"}


@router.post("/broadcasts/{broadcast_id}/cancel", summary="Отменить рассылку")
async def cancel_broadcast(
    event_id: int,
    broadcast_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    row = await db.fetchrow(
        "UPDATE conf_broadcast_messages SET status='cancelled' WHERE id=$1 AND event_id=$2 RETURNING *",
        broadcast_id, event_id
    )
    return {"broadcast": dict(row)}


@router.post("/broadcasts/{broadcast_id}/test", summary="Тест рассылки — отправить себе")
async def test_broadcast(
    event_id: int,
    broadcast_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    broadcast = await db.fetchrow(
        "SELECT * FROM conf_broadcast_messages WHERE id=$1 AND event_id=$2", broadcast_id, event_id
    )
    if not broadcast:
        raise HTTPException(status_code=404, detail="Рассылка не найдена")

    # Получаем Telegram клиента
    client_row = await db.fetchrow(
        "SELECT telegram_username FROM clients WHERE id=$1", int(client["sub"])
    )

    import httpx, os
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    text = f"🧪 ТЕСТ РАССЫЛКИ\n\n{broadcast['text']}"

    # Ищем tg_id клиента по username
    if client_row and client_row["telegram_username"]:
        username = client_row["telegram_username"].lstrip("@")
        tg_user = await db.fetchrow(
            "SELECT tg_id FROM telegram_users WHERE username=$1", username
        )
        if tg_user:
            async with httpx.AsyncClient() as http:
                await http.post(
                    f"https://api.telegram.org/bot{bot_token}/sendMessage",
                    json={"chat_id": tg_user["tg_id"], "text": text}
                )
            return {"message": "Тест отправлен в Telegram"}

    return {"message": "Telegram-аккаунт не найден. Укажите @username в настройках профиля."}


@router.post("/broadcasts/generate-from-schedule", summary="Авто-создать рассылки из программы")
async def generate_broadcasts_from_schedule(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    sessions = await db.fetch(
        """SELECT s.*, spg.name AS speaker_name, cse.gift_title, cse.gift_url
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN speakers spg ON spg.id = cse.speaker_id
           WHERE s.event_id = $1 AND s.start_datetime IS NOT NULL
           ORDER BY s.day, s.start_datetime""",
        event_id
    )

    created = 0
    for s in sessions:
        if not s["start_datetime"]:
            continue
        # За 5 минут до старта
        pre5 = s["start_datetime"] - timedelta(minutes=5)
        speaker_name = s["speaker_name"] or "Спикер"
        title = s["title"] or "Выступление"

        existing = await db.fetchrow(
            "SELECT id FROM conf_broadcast_messages WHERE session_id=$1 AND type='pre_5min'",
            s["id"]
        )
        if not existing:
            await db.execute(
                """INSERT INTO conf_broadcast_messages
                   (event_id, session_id, speaker_id, type, scheduled_at, text, status)
                   VALUES ($1,$2,$3,'pre_5min',$4,$5,'draft')""",
                event_id, s["id"], s["speaker_id"], pre5,
                f"🔔 Через 5 минут начинается выступление!\n\n👤 {speaker_name}\n📌 {title}\n\nНе пропусти!"
            )
            created += 1

        # После выступления — подарок
        if s["end_datetime"] and (s["gift_title"] or s.get("gift_description")):
            gift_text = s["gift_title"] or s["gift_description"] or "Подарок"
            gift_url = s["gift_url"] or ""
            existing2 = await db.fetchrow(
                "SELECT id FROM conf_broadcast_messages WHERE session_id=$1 AND type='post_thanks'",
                s["id"]
            )
            if not existing2:
                gift_msg = f"🎁 {speaker_name} дарит подарок!\n\n{gift_text}"
                if gift_url:
                    gift_msg += f"\n\n👉 Получить: {gift_url}"
                await db.execute(
                    """INSERT INTO conf_broadcast_messages
                       (event_id, session_id, speaker_id, type, scheduled_at, text, status)
                       VALUES ($1,$2,$3,'post_thanks',$4,$5,'draft')""",
                    event_id, s["id"], s["speaker_id"], s["end_datetime"], gift_msg
                )
                created += 1

    return {"message": f"Создано {created} рассылок из расписания"}


# ─── Коммерческие предложения ──────────────────────────────────────────────────

class CommercialItemCreate(BaseModel):
    type: str = "service"
    title: str
    description: Optional[str] = None
    is_paid: bool = False
    action_url: Optional[str] = None
    sort_order: int = 0


@router.get("/commercial", summary="Услуги и материалы")
async def list_commercial(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    items = await db.fetch(
        "SELECT * FROM conf_commercial_items WHERE event_id = $1 ORDER BY sort_order", event_id
    )
    return {"items": [dict(i) for i in items]}


@router.post("/commercial", summary="Добавить услугу/материал")
async def create_commercial_item(
    event_id: int, data: CommercialItemCreate,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    item = await db.fetchrow(
        """INSERT INTO conf_commercial_items (event_id, type, title, description, is_paid, action_url, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
        event_id, data.type, data.title, data.description, data.is_paid, data.action_url, data.sort_order
    )
    return {"item": dict(item)}


@router.delete("/commercial/{item_id}", summary="Удалить услугу")
async def delete_commercial_item(
    event_id: int, item_id: int,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    await db.execute("DELETE FROM conf_commercial_items WHERE id=$1 AND event_id=$2", item_id, event_id)
    return {"message": "Удалено"}


# ─── Кодовые слова ────────────────────────────────────────────────────────────

class SecretCodeCreate(BaseModel):
    speaker_id: Optional[int] = None
    code_word: str
    tickets_reward: int = 1


class VerifyCodeRequest(BaseModel):
    code: str
    participant_id: int


@router.get("/codes", summary="Кодовые слова")
async def list_secret_codes(
    event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    codes = await db.fetch(
        """SELECT sc.*, sp.name as speaker_name FROM conf_secret_codes sc
           LEFT JOIN conf_speakers sp ON sp.id = sc.speaker_id WHERE sc.event_id = $1""",
        event_id
    )
    return {"codes": [dict(c) for c in codes]}


@router.post("/codes", summary="Добавить кодовое слово")
async def create_secret_code(
    event_id: int, data: SecretCodeCreate,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    code = await db.fetchrow(
        "INSERT INTO conf_secret_codes (event_id, speaker_id, code_word, tickets_reward) VALUES ($1,$2,$3,$4) RETURNING *",
        event_id, data.speaker_id, data.code_word.lower().strip(), data.tickets_reward
    )
    return {"code": dict(code)}


@router.post("/codes/verify", summary="Проверить кодовое слово")
async def verify_code(event_id: int, data: VerifyCodeRequest, db: asyncpg.Connection = Depends(get_db)):
    code = await db.fetchrow(
        "SELECT * FROM conf_secret_codes WHERE event_id=$1 AND code_word=$2",
        event_id, data.code.lower().strip()
    )
    if not code:
        return {"valid": False, "message": "Неверное слово, попробуйте ещё раз"}
    await db.execute(
        "UPDATE event_participants SET points_total = points_total + $1 WHERE id=$2",
        code["tickets_reward"], data.participant_id
    )
    return {"valid": True, "tickets_reward": code["tickets_reward"],
            "message": f"Поздравляем! Вы получили {code['tickets_reward']} билетов на розыгрыш"}


# ─── Промо-партнёры ───────────────────────────────────────────────────────────

class PromoPartnerCreate(BaseModel):
    name: str
    telegram_url: Optional[str] = None
    partner_code: str


@router.get("/promo-partners", summary="Промо-партнёры события")
async def list_promo_partners(
    event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    partners = await db.fetch(
        "SELECT * FROM conf_promo_partners WHERE event_id=$1 ORDER BY created_at", event_id
    )
    return {"partners": [dict(p) for p in partners]}


@router.post("/promo-partners", summary="Добавить промо-партнёра")
async def create_promo_partner(
    event_id: int, data: PromoPartnerCreate,
    client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    partner = await db.fetchrow(
        "INSERT INTO conf_promo_partners (event_id, name, telegram_url, partner_code) VALUES ($1,$2,$3,$4) RETURNING *",
        event_id, data.name, data.telegram_url, data.partner_code.upper()
    )
    return {"partner": dict(partner)}
