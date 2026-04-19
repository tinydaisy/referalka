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
        """SELECT cse.*, sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1 AND cse.is_visible = TRUE
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    sessions = await db.fetch(
        """SELECT s.*, sp.name AS speaker_name, cse.role AS speaker_role,
                  sp.title AS speaker_title, sp.photo_url, cse.gift_after_speech_title, cse.gift_after_speech_url
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
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
                    "gift_title": s["gift_after_speech_title"],
                    "gift_url": s["gift_after_speech_url"],
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
                "photo_url": s["photo_url"] or "",
                "tg_channel_url": s["tg_channel_url"] or "",
                "speaker_topic": s["speaker_topic"] or "",
                "gift_after_speech_title": s["gift_after_speech_title"] or "",
                "gift_after_speech_url": s["gift_after_speech_url"] or "",
                "gift_raffle_title": s["gift_raffle_title"] or "",
                "gift_raffle_url": s["gift_raffle_url"] or "",
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
    subscription_mode: Optional[str] = None   # none | organizer | all_speakers
    organizer_speaker_id: Optional[int] = None
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
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
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
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    # Данные участия в этом событии
    role: str = "speaker"
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    poster_url: Optional[str] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    is_commercial: bool = False
    is_visible: bool = True
    sort_order: int = 0


class SpeakerEventUpdate(BaseModel):
    """Обновить данные участия спикера в событии (тема, подарок, роль и т.д.)"""
    role: Optional[str] = None
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    poster_url: Optional[str] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    is_commercial: Optional[bool] = None
    is_visible: Optional[bool] = None
    sort_order: Optional[int] = None


def _speaker_row_to_dict(row) -> dict:
    """Объединяет данные из speakers + conf_speaker_events в один объект."""
    d = dict(row)
    return d


async def _load_topics(cse_ids: list, db) -> dict:
    """Загружает темы для списка conf_speaker_events.id. Возвращает {cse_id: [{id, topic}, ...]}."""
    if not cse_ids:
        return {}
    rows = await db.fetch(
        "SELECT id, cse_id, topic FROM conf_speaker_topics WHERE cse_id = ANY($1::int[]) ORDER BY cse_id, sort_order",
        cse_ids
    )
    result: dict = {}
    for r in rows:
        result.setdefault(r["cse_id"], []).append({"id": r["id"], "topic": r["topic"]})
    return result


async def _save_topics(cse_id: int, topics: list, db) -> None:
    """Полностью заменяет темы спикера в событии."""
    await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id = $1", cse_id)
    for i, topic in enumerate(topics):
        if topic.strip():
            await db.execute(
                "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1, $2, $3)",
                cse_id, topic.strip(), i
            )


@router.get("/speakers", summary="Спикеры события")
async def list_event_speakers(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.poster_url, cse.partner_url, cse.extra_info,
                  cse.ref_code, cse.is_visible, cse.sort_order, cse.is_commercial,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url, sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)
    result = []
    for r in rows:
        d = dict(r)
        d["topics"] = topics_map.get(d["id"], [])
        result.append(d)
    return {"speakers": result}


@router.get("/speakers/public", summary="Спикеры для Mini App")
async def list_event_speakers_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT cse.id, cse.role, cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url, cse.sort_order,
                  sp.name, sp.title, sp.photo_url, sp.tg_channel_url
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1 AND cse.is_visible = TRUE
           ORDER BY cse.sort_order""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)
    result = []
    for r in rows:
        d = dict(r)
        d["topics"] = topics_map.get(d["id"], [])
        result.append(d)
    return {"speakers": result}


@router.get("/speakers/{speaker_event_id}/public", summary="Полный профиль спикера для публичной страницы проверки")
async def get_speaker_profile_public(event_id: int, speaker_event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный endpoint без авторизации.
    Возвращает полные данные спикера (профиль + данные выступления) для страницы проверки данных.
    Спикер может открыть ссылку и убедиться, что его данные заполнены правильно.
    """
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.poster_url AS event_poster_url,
                  cse.is_commercial,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id, sp.personal_tg_id, sp.personal_tg_username, sp.assistant_tg_username
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1 AND cse.event_id = $2""",
        speaker_event_id, event_id
    )
    if not row:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Спикер не найден")
    topics_map = await _load_topics([speaker_event_id], db)
    d = dict(row)
    d["topics"] = topics_map.get(speaker_event_id, [])
    return {"speaker": d}


@router.post("/speakers/add-from-base", summary="Добавить спикера из базы в событие")
async def add_speaker_from_base(
    event_id: int,
    data: SpeakerAddToEvent,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    # Проверяем что спикер существует
    sp = await db.fetchrow("SELECT id FROM collaborators WHERE id = $1", data.speaker_id)
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

    # Определяем темы: если передан topics — используем его, иначе speaker_topic
    topics_list = data.topics if data.topics is not None else (
        [data.speaker_topic] if data.speaker_topic else []
    )
    first_topic = topics_list[0] if topics_list else None

    cse = await db.fetchrow(
        """INSERT INTO conf_speaker_events
           (speaker_id, event_id, role, speaker_topic, gift_after_speech_title, gift_after_speech_url,
            gift_raffle_title, gift_raffle_url,
            poster_url, partner_url, extra_info, ref_code, is_commercial, is_visible, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *""",
        data.speaker_id, event_id, data.role, first_topic,
        data.gift_after_speech_title, data.gift_after_speech_url,
        data.gift_raffle_title, data.gift_raffle_url,
        data.poster_url, data.partner_url, data.extra_info,
        ref_code, data.is_commercial, data.is_visible, data.sort_order
    )
    await _save_topics(cse["id"], topics_list, db)
    # Возвращаем с данными из глобальной базы
    row = await db.fetchrow(
        """SELECT cse.*, sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url, sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1""",
        cse["id"]
    )
    d = dict(row)
    topics_map = await _load_topics([cse["id"]], db)
    d["topics"] = topics_map.get(cse["id"], [])
    await regenerate_landing_data(event_id, db)
    return {"speaker": d}


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
        """INSERT INTO collaborators
           (name, title, achievements,
            photo_url, photo_folder_url, video_folder_url,
            tg_channel_url, instagram_url, website_url, created_by_client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *""",
        data.name, data.title, data.achievements,
        data.photo_url, data.photo_folder_url, data.video_folder_url,
        data.tg_channel_url, data.instagram_url, data.website_url,
        int(client["sub"])
    )

    # 2. Добавляем в событие
    import random, string
    ref_code = "sp_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))

    topics_list = data.topics if data.topics is not None else (
        [data.speaker_topic] if data.speaker_topic else []
    )
    first_topic = topics_list[0] if topics_list else None

    cse = await db.fetchrow(
        """INSERT INTO conf_speaker_events
           (speaker_id, event_id, role, speaker_topic, gift_after_speech_title, gift_after_speech_url,
            gift_raffle_title, gift_raffle_url,
            poster_url, partner_url, extra_info, ref_code, is_commercial, is_visible, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *""",
        sp["id"], event_id, data.role, first_topic,
        data.gift_after_speech_title, data.gift_after_speech_url,
        data.gift_raffle_title, data.gift_raffle_url,
        data.poster_url, data.partner_url, data.extra_info,
        ref_code, data.is_commercial, data.is_visible, data.sort_order
    )
    await _save_topics(cse["id"], topics_list, db)
    topics_map = await _load_topics([cse["id"]], db)
    result = {**dict(sp), **dict(cse), "speaker_id": sp["id"], "topics": topics_map.get(cse["id"], [])}
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
    raw = data.model_dump()
    topics_list = raw.pop("topics", None)
    # Не обновляем speaker_topic через общий механизм — управляем темами отдельно
    raw.pop("speaker_topic", None)
    updates = {k: v for k, v in raw.items() if v is not None}
    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        await db.execute(
            f"UPDATE conf_speaker_events SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2",
            speaker_event_id, event_id, *updates.values()
        )
    if topics_list is not None:
        await _save_topics(speaker_event_id, topics_list, db)
        first_topic = topics_list[0] if topics_list else None
        await db.execute(
            "UPDATE conf_speaker_events SET speaker_topic=$1 WHERE id=$2",
            first_topic, speaker_event_id
        )
    row = await db.fetchrow(
        """SELECT cse.*, sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url, sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM conf_speaker_events cse JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1""",
        speaker_event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден в событии")
    topics_map = await _load_topics([speaker_event_id], db)
    d = dict(row)
    d["topics"] = topics_map.get(speaker_event_id, [])
    await regenerate_landing_data(event_id, db)
    return {"speaker": d}


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
    topic_id: Optional[int] = None
    day: int
    start_datetime: Optional[str] = None
    end_datetime: Optional[str] = None
    title: Optional[str] = None  # если не передан — берётся из topic_id
    gift_description: Optional[str] = None
    stream_url: Optional[str] = None
    track_label: Optional[str] = None
    track_color: Optional[str] = None
    sort_order: int = 0


class SessionUpdate(BaseModel):
    speaker_id: Optional[int] = None
    topic_id: Optional[int] = None
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
        """SELECT s.*, col.name as speaker_name, col.title as speaker_title,
                  col.photo_url, cse.role as speaker_role
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
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
                  col.name as speaker_name, col.title as speaker_title,
                  col.photo_url, cse.gift_after_speech_title, cse.gift_after_speech_url
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
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

    # Если передан topic_id — берём title из темы (если title не передан явно)
    title = data.title
    if data.topic_id and not title:
        row = await db.fetchrow("SELECT topic FROM conf_speaker_topics WHERE id = $1", data.topic_id)
        if row:
            title = row["topic"]
    if not title:
        raise HTTPException(status_code=422, detail="Нужно указать тему слота или выбрать тему спикера")

    session = await db.fetchrow(
        """INSERT INTO conf_sessions
          (event_id, speaker_id, topic_id, day, start_datetime, end_datetime, title,
           gift_description, stream_url, track_label, track_color, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *""",
        event_id, data.speaker_id, data.topic_id, data.day, start_dt, end_dt, title,
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

    # Если меняется topic_id но title не передан — обновляем title из темы
    if "topic_id" in updates and "title" not in updates:
        row = await db.fetchrow("SELECT topic FROM conf_speaker_topics WHERE id = $1", updates["topic_id"])
        if row:
            updates["title"] = row["topic"]

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
               JOIN collaborators sp ON sp.id = cse.speaker_id
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
        """SELECT b.*, col.name as speaker_name, s.title as session_title,
                  s.start_datetime as session_time
           FROM conf_broadcast_messages b
           LEFT JOIN conf_speaker_events cse ON cse.id = b.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
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
        """SELECT s.*, spg.name AS speaker_name, cse.gift_after_speech_title, cse.gift_after_speech_url
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators spg ON spg.id = cse.speaker_id
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
        if s["end_datetime"] and (s["gift_after_speech_title"] or s.get("gift_description")):
            gift_text = s["gift_after_speech_title"] or s["gift_description"] or "Подарок"
            gift_url = s["gift_after_speech_url"] or ""
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
        """SELECT sc.*, col.name as speaker_name FROM conf_secret_codes sc
           LEFT JOIN conf_speaker_events cse ON cse.id = sc.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           WHERE sc.event_id = $1""",
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


# ─── Публичное саморедактирование спикера по ref_code ────────────────────────
# Спикер получает персональную ссылку вида /speaker-edit.html?code=sp_xxxx
# и может сам проверить и исправить свои данные без авторизации в кабинете.

class SpeakerSelfUpdate(BaseModel):
    """Поля, которые спикер может обновить сам."""
    # Профиль (таблица collaborators)
    name: Optional[str] = None
    title: Optional[str] = None
    achievements: Optional[List[str]] = None
    photo_url: Optional[str] = None
    poster_url: Optional[str] = None
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    # Данные выступления (таблица conf_speaker_events)
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    keyword_code: Optional[str] = None


@router.get("/speakers/by-code/{ref_code}", summary="Профиль спикера по ref_code (без авторизации)")
async def get_speaker_by_ref_code(event_id: int, ref_code: str, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный endpoint без авторизации.
    Возвращает полные данные спикера по его персональному ref_code.
    Используется для страницы самопроверки/редактирования спикером.
    """
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.is_commercial, cse.ref_code, cse.keyword_code,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id, sp.personal_tg_id, sp.personal_tg_username, sp.assistant_tg_username
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.ref_code = $1 AND cse.event_id = $2""",
        ref_code, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Ссылка недействительна")
    topics_map = await _load_topics([row["id"]], db)
    d = dict(row)
    d["topics"] = topics_map.get(d["id"], [])
    return {"speaker": d}


@router.patch("/speakers/by-code/{ref_code}", summary="Обновить данные спикера по ref_code (без авторизации)")
async def update_speaker_by_ref_code(
    event_id: int,
    ref_code: str,
    data: SpeakerSelfUpdate,
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Публичный endpoint без авторизации.
    Позволяет спикеру самостоятельно обновить свои данные по персональной ссылке.
    Обновляет и профиль (collaborators), и данные выступления (conf_speaker_events).
    """
    cse = await db.fetchrow(
        "SELECT id, speaker_id FROM conf_speaker_events WHERE ref_code = $1 AND event_id = $2",
        ref_code, event_id
    )
    if not cse:
        raise HTTPException(status_code=404, detail="Ссылка недействительна")

    speaker_event_id = cse["id"]
    speaker_id = cse["speaker_id"]

    # Обновляем глобальный профиль спикера (collaborators)
    profile_fields = ["name", "title", "achievements", "photo_url", "poster_url",
                      "photo_folder_url", "video_folder_url", "tg_channel_url",
                      "instagram_url", "website_url", "tg_channel_id",
                      "personal_tg_id", "personal_tg_username", "assistant_tg_username"]
    profile_updates = {}
    for k in profile_fields:
        v = getattr(data, k)
        if v is not None:
            profile_updates[k] = v

    if profile_updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(profile_updates.keys())]
        set_parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(set_parts)} WHERE id = $1",
            speaker_id, *profile_updates.values()
        )

    # Обновляем данные выступления (conf_speaker_events)
    event_updates: dict = {}
    if data.gift_after_speech_title is not None:
        event_updates["gift_after_speech_title"] = data.gift_after_speech_title
    if data.gift_after_speech_url is not None:
        event_updates["gift_after_speech_url"] = data.gift_after_speech_url
    if data.gift_raffle_title is not None:
        event_updates["gift_raffle_title"] = data.gift_raffle_title
    if data.gift_raffle_url is not None:
        event_updates["gift_raffle_url"] = data.gift_raffle_url

    if event_updates:
        set_parts2 = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE conf_speaker_events SET {', '.join(set_parts2)} WHERE id = $1",
            speaker_event_id, *event_updates.values()
        )

    # Темы выступления
    if data.topics is not None:
        await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id = $1", speaker_event_id)
        topics = [t.strip() for t in data.topics if t.strip()]
        if topics:
            first_topic = topics[0]
            await db.execute(
                "UPDATE conf_speaker_events SET speaker_topic = $1 WHERE id = $2",
                first_topic, speaker_event_id
            )
            for i, topic in enumerate(topics):
                await db.execute(
                    "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1, $2, $3)",
                    speaker_event_id, topic, i
                )

    # Возвращаем обновлённые данные
    return await get_speaker_by_ref_code(event_id, ref_code, db)


# ─── Режим ассистента: один код на всё событие ───────────────────────────────

@router.get("/editor-info", summary="Данные конференции по editor_code (публичный)")
async def get_editor_info(event_id: int, code: str, db: asyncpg.Connection = Depends(get_db)):
    """Публичный endpoint — проверяет editor_code и возвращает список всех спикеров."""
    conf = await db.fetchrow(
        "SELECT event_id, editor_code FROM conf_conferences WHERE event_id = $1 AND editor_code = $2",
        event_id, code
    )
    if not conf:
        raise HTTPException(status_code=403, detail="Неверный код доступа")

    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role, cse.ref_code, cse.keyword_code,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.is_commercial,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id, sp.personal_tg_id, sp.personal_tg_username, sp.assistant_tg_username
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)
    result = []
    for r in rows:
        d = dict(r)
        d["topics"] = topics_map.get(d["id"], [])
        result.append(d)
    return {"speakers": result, "event_id": event_id}


@router.patch("/speakers/{speaker_event_id}/editor", summary="Обновить данные спикера от имени ассистента")
async def update_speaker_as_editor(
    event_id: int,
    speaker_event_id: int,
    data: SpeakerSelfUpdate,
    code: str,
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Публичный endpoint — ассистент обновляет данные любого спикера по editor_code.
    """
    conf = await db.fetchrow(
        "SELECT event_id FROM conf_conferences WHERE event_id = $1 AND editor_code = $2",
        event_id, code
    )
    if not conf:
        raise HTTPException(status_code=403, detail="Неверный код доступа")

    cse = await db.fetchrow(
        "SELECT id, speaker_id FROM conf_speaker_events WHERE id = $1 AND event_id = $2",
        speaker_event_id, event_id
    )
    if not cse:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    speaker_id = cse["speaker_id"]

    # Профиль
    profile_fields = ["name", "title", "achievements", "photo_url", "poster_url",
                      "photo_folder_url", "video_folder_url", "tg_channel_url",
                      "instagram_url", "website_url", "tg_channel_id",
                      "personal_tg_id", "personal_tg_username", "assistant_tg_username"]
    profile_updates = {k: getattr(data, k) for k in profile_fields if getattr(data, k) is not None}
    if profile_updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(profile_updates.keys())]
        set_parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(set_parts)} WHERE id = $1",
            speaker_id, *profile_updates.values()
        )

    # Выступление
    event_updates: dict = {}
    for k in ["gift_after_speech_title", "gift_after_speech_url", "gift_raffle_title", "gift_raffle_url", "keyword_code"]:
        v = getattr(data, k, None)
        if v is not None:
            event_updates[k] = v
    if event_updates:
        set_parts2 = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE conf_speaker_events SET {', '.join(set_parts2)} WHERE id = $1",
            speaker_event_id, *event_updates.values()
        )

    # Темы
    if data.topics is not None:
        await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id = $1", speaker_event_id)
        clean_topics = [t.strip() for t in data.topics if t.strip()]
        if clean_topics:
            await db.execute(
                "UPDATE conf_speaker_events SET speaker_topic = $1 WHERE id = $2",
                clean_topics[0], speaker_event_id
            )
            for i, topic in enumerate(clean_topics):
                await db.execute(
                    "INSERT INTO conf_speaker_topics (cse_id, topic, sort_order) VALUES ($1, $2, $3)",
                    speaker_event_id, topic, i
                )

    # Возвращаем обновлённые данные
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role, cse.ref_code, cse.keyword_code,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url, cse.is_commercial,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id, sp.personal_tg_id, sp.personal_tg_username, sp.assistant_tg_username
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1""",
        speaker_event_id
    )
    topics_map = await _load_topics([speaker_event_id], db)
    d = dict(row)
    d["topics"] = topics_map.get(speaker_event_id, [])
    return {"speaker": d}


@router.post("/generate-editor-code", summary="Сгенерировать editor_code для конференции")
async def generate_editor_code(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Генерирует или обновляет editor_code для конференции."""
    await check_conference_access(event_id, int(client["sub"]), db)
    import random, string
    new_code = "edit_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    await db.execute(
        "UPDATE conf_conferences SET editor_code = $1 WHERE event_id = $2",
        new_code, event_id
    )
    return {"editor_code": new_code, "event_id": event_id}


@router.get("/export/salebot", summary="Экспорт для Salebot в виде .txt файла")
async def export_salebot(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    from fastapi.responses import Response
    await check_conference_access(event_id, int(client["sub"]), db)

    event = await db.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
    conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)

    # Спикеры с темами (регалиями)
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.role,
                  cse.gift_after_speech_title, cse.gift_raffle_title,
                  cse.sort_order, cse.is_visible,
                  sp.name, sp.title, sp.achievements,
                  sp.tg_channel_url, sp.tg_channel_id
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)

    # Программа: дни + сессии
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    sessions = await db.fetch(
        """SELECT s.*, sp.name AS speaker_name, cse.role AS speaker_role,
                  cse.gift_raffle_title
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1 ORDER BY s.day, s.sort_order, s.start_datetime""",
        event_id
    )

    # organizer_speaker_id для определения организатора
    organizer_cse_id = conf["organizer_speaker_id"] if conf else None

    def fmt_time(val):
        if val is None:
            return ""
        if hasattr(val, "strftime"):
            return val.strftime("%H:%M")
        return str(val)[:5]

    def fmt_date(val):
        if val is None:
            return ""
        months = ["января","февраля","марта","апреля","мая","июня",
                  "июля","августа","сентября","октября","ноября","декабря"]
        if hasattr(val, "day"):
            return f"{val.day} {months[val.month - 1]}"
        return str(val)

    lines = []

    # ─── ИНФО О СПИКЕРАХ ───
    lines.append("ИНФО О СПИКЕРАХ:")
    lines.append("")

    speakers_list = [dict(r) for r in rows]
    for i, sp in enumerate(speakers_list):
        lines.append(f"{sp['name']}")

        tg = sp.get("tg_channel_url") or ""
        if tg.strip():
            lines.append(f"(Ссылка на тг канал: {tg.strip()})")
        else:
            lines.append("(Ссылка на тг канал: —)")

        lines.append("")

        lines.append("Тема лекции:")
        lines.append("")

        # Регалии из topics или achievements
        sp_topics = topics_map.get(sp["id"], [])
        if sp_topics:
            achievements_list = [t["topic"] for t in sp_topics if t["topic"].strip()]
        else:
            raw = sp.get("achievements") or []
            if isinstance(raw, str):
                import json as _json
                try:
                    raw = _json.loads(raw)
                except Exception:
                    raw = [raw] if raw.strip() else []
            achievements_list = [a for a in raw if str(a).strip()]

        if achievements_list:
            for ach in achievements_list:
                lines.append(f"• {ach}")
        else:
            lines.append("• (регалии уточняются)")

        lines.append("")

        gift_speech = (sp.get("gift_after_speech_title") or "").strip()
        gift_raffle = (sp.get("gift_raffle_title") or "").strip()

        if gift_speech:
            lines.append(f"🎁 На эфире подарит: {gift_speech}")
            lines.append("")

        if gift_raffle:
            lines.append(f"🏆Подарок для большого розыгрыша: {gift_raffle}")
            lines.append("")

        if i < len(speakers_list) - 1:
            lines.append("###")
            lines.append("")

    lines.append("")
    lines.append("—")

    # ─── ПРОГРАММА ───
    lines.append("ПРОГРАММА Конференции:")
    lines.append("")

    for d in days:
        day_num = d["day_number"]
        day_date = fmt_date(d["day_date"])
        lines.append(f"ДЕНЬ {day_num} - {day_date}" if day_date else f"ДЕНЬ {day_num}")
        lines.append("")

        day_sessions = [s for s in sessions if s["day"] == day_num]
        for s in day_sessions:
            t_start = fmt_time(s["start_datetime"])
            t_end = fmt_time(s["end_datetime"])
            time_part = f"{t_start} - {t_end}: " if (t_start or t_end) else ""
            title_part = s["title"] or ""
            sp_name = s.get("speaker_name") or ""
            sp_role = (s.get("speaker_role") or "").strip()
            show_role = sp_role in ("headliner", "partner", "хедлайнер", "партнер")
            if sp_name and show_role:
                person_part = f" ({sp_name} - {sp_role})"
            elif sp_name:
                person_part = f" ({sp_name})"
            else:
                person_part = ""
            lines.append(f"{time_part}{title_part}{person_part}")

        lines.append("")

    lines.append("—")

    # ─── ПОДАРКИ ДЛЯ РОЗЫГРЫША ───
    lines.append("ПОДАРКИ ДЛЯ РОЗЫГРЫША")
    lines.append("")

    raffle_speakers = [(sp["name"], sp["gift_raffle_title"]) for sp in speakers_list if (sp.get("gift_raffle_title") or "").strip()]
    for idx, (sp_name, gift_title) in enumerate(raffle_speakers, 1):
        lines.append(f"{idx}.{gift_title} ({sp_name})")

    lines.append("")
    lines.append("—")

    # ─── КАНАЛЫ НА ПОДПИСКУ ───
    lines.append("Список каналов на подписку :")
    lines.append("")

    # Организатор всегда первый
    channel_entries = []
    organizer_added = set()

    # Ищем организатора по organizer_cse_id
    if organizer_cse_id:
        org = next((sp for sp in speakers_list if sp["id"] == organizer_cse_id), None)
        if org and (org.get("tg_channel_url") or "").strip():
            channel_entries.append((org["name"], org["tg_channel_url"].strip()))
            organizer_added.add(org["id"])

    for sp in speakers_list:
        if sp["id"] in organizer_added:
            continue
        tg = (sp.get("tg_channel_url") or "").strip()
        if tg:
            channel_entries.append((sp["name"], tg))

    for idx, (sp_name, tg_url) in enumerate(channel_entries, 1):
        lines.append(f"{idx}.{sp_name}: {tg_url}")

    lines.append("")
    lines.append("—")

    # ─── СПИСОК ID КАНАЛОВ СПИКЕРОВ ───
    lines.append("Список id каналов спикеров")
    lines.append("")

    id_entries = []
    if organizer_cse_id:
        org = next((sp for sp in speakers_list if sp["id"] == organizer_cse_id), None)
        if org and (org.get("tg_channel_id") or "").strip():
            id_entries.append((org["name"], org["tg_channel_id"].strip()))
            organizer_id_added = {org["id"]}
        else:
            organizer_id_added = set()
    else:
        organizer_id_added = set()

    for sp in speakers_list:
        if sp["id"] in organizer_id_added:
            continue
        ch_id = (sp.get("tg_channel_id") or "").strip()
        if ch_id:
            id_entries.append((sp["name"], ch_id))

    for idx, (sp_name, ch_id) in enumerate(id_entries, 1):
        lines.append(f"{idx}.{sp_name}: {ch_id}")

    text = "\n".join(lines)

    slug = event["slug"] if event and event.get("slug") else str(event_id)
    filename = f"{slug}_info.txt"
    from urllib.parse import quote
    encoded_filename = quote(filename, safe="")

    return Response(
        content=text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
    )
