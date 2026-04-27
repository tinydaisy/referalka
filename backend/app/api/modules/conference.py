from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
import asyncpg
import re
import json
import httpx
from datetime import datetime, date, time, timedelta

router = APIRouter(prefix="/events/{event_id}/conference", tags=["Конференция"])


_TRANSLIT_MAP = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
    'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
}


def slugify(name: str) -> str:
    s = name.lower().strip()
    s = ''.join(_TRANSLIT_MAP.get(ch, ch) for ch in s)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s).strip('-')
    return s[:60] or 'item'


async def check_conference_access(event_id: int, client_id: int, db: asyncpg.Connection):
    event = await db.fetchrow(
        "SELECT id, module_slug FROM events WHERE id = $1 AND client_id = $2",
        event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    return event


async def ensure_collaborator_contact(collaborator_id: int, db: asyncpg.Connection) -> str:
    """
    Гарантирует что у коллаборатора есть связанный контакт в contacts
    с заполненным ref_code. Возвращает ref_code.

    Логика:
    - Если у collaborators.contact_id уже стоит FK → вернём contacts.ref_code
      (генерим если NULL — но в новой схеме ref_code обязателен при создании contacts)
    - Иначе создаём contact (с уникальным ref_code) и привязываем его к collaborator
    - Если у коллаба есть personal_tg_id — также создаём/находим platform_users
      (platform_slug='telegram') с привязкой к этому contact_id
    """
    from app.services.contact_merge import _generate_unique_ref_code, upsert_platform_user

    coll = await db.fetchrow(
        "SELECT id, created_by_client_id, personal_tg_id, personal_tg_username, contact_id, name FROM collaborators WHERE id = $1",
        collaborator_id
    )
    if not coll:
        raise HTTPException(status_code=404, detail="Коллаборатор не найден")

    contact_id = coll["contact_id"]

    # 1. Если контакта ещё нет — создаём
    if not contact_id:
        ref_code = await _generate_unique_ref_code(db)
        contact_id = await db.fetchval(
            """INSERT INTO contacts (client_id, name, ref_code, is_active, tags, merged_ref_codes)
               VALUES ($1, $2, $3, TRUE, '[]'::JSONB, '[]'::JSONB)
               RETURNING id""",
            coll["created_by_client_id"], coll["name"], ref_code
        )
        # Запишем FK в коллаб
        await db.execute(
            "UPDATE collaborators SET contact_id = $1 WHERE id = $2",
            contact_id, coll["id"]
        )
    else:
        ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", contact_id)
        if not ref_code:
            ref_code = await _generate_unique_ref_code(db)
            await db.execute("UPDATE contacts SET ref_code = $1 WHERE id = $2", ref_code, contact_id)

    # 2. Если есть personal_tg_id — создаём/обновляем platform_users (telegram)
    if coll["personal_tg_id"]:
        await upsert_platform_user(
            db,
            contact_id=contact_id,
            client_id=coll["created_by_client_id"],
            platform_slug="telegram",
            platform_user_id=str(coll["personal_tg_id"]),
            username=coll["personal_tg_username"],
            first_name=coll["name"],
        )

    return ref_code


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
    test_telegram_ids: Optional[List[str]] = None
    raffle_url: Optional[str] = None
    telegram_chat_ids: Optional[str] = None     # ID чатов/каналов через запятую


@router.get("/", summary="Данные конференции")
async def get_conference(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    conf = await db.fetchrow(
        """
        SELECT cc.*, e.title as event_title
        FROM conf_conferences cc
        JOIN events e ON e.id = cc.event_id
        WHERE cc.event_id = $1
        """,
        event_id
    )
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
    for k, v in data.model_dump(exclude_unset=True).items():
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
    notes: Optional[str] = None
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
    notes: Optional[str] = None
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
    notes: Optional[str] = None
    is_commercial: Optional[bool] = None
    is_visible: Optional[bool] = None
    sort_order: Optional[int] = None
    bot_in_channel: Optional[bool] = None
    priority: Optional[int] = None
    exclude_gift_from_broadcast: Optional[bool] = None
    exclude_channel_from_subscription: Optional[bool] = None


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
                  cse.poster_url, cse.partner_url, cse.extra_info, cse.notes,
                  c.ref_code, cse.is_visible, cse.sort_order, cse.is_commercial,
                  cse.bot_in_channel, cse.priority,
                  cse.exclude_gift_from_broadcast, cse.exclude_channel_from_subscription,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url, sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.personal_tg_username
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
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

    # Гарантируем что у коллаба есть контакт с ref_code (это и будет реф-код спикера)
    await ensure_collaborator_contact(data.speaker_id, db)

    # Определяем темы: если передан topics — используем его, иначе speaker_topic
    topics_list = data.topics if data.topics is not None else (
        [data.speaker_topic] if data.speaker_topic else []
    )
    first_topic = topics_list[0] if topics_list else None

    cse = await db.fetchrow(
        """INSERT INTO conf_speaker_events
           (speaker_id, event_id, role, speaker_topic, gift_after_speech_title, gift_after_speech_url,
            gift_raffle_title, gift_raffle_url,
            poster_url, partner_url, extra_info, notes, is_commercial, is_visible, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *""",
        data.speaker_id, event_id, data.role, first_topic,
        data.gift_after_speech_title, data.gift_after_speech_url,
        data.gift_raffle_title, data.gift_raffle_url,
        data.poster_url, data.partner_url, data.extra_info, data.notes,
        data.is_commercial, data.is_visible, data.sort_order
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

    # 2. Гарантируем контакт + ref_code у нового коллаба (создаст плейсхолдер если нужно)
    await ensure_collaborator_contact(sp["id"], db)

    topics_list = data.topics if data.topics is not None else (
        [data.speaker_topic] if data.speaker_topic else []
    )
    first_topic = topics_list[0] if topics_list else None

    cse = await db.fetchrow(
        """INSERT INTO conf_speaker_events
           (speaker_id, event_id, role, speaker_topic, gift_after_speech_title, gift_after_speech_url,
            gift_raffle_title, gift_raffle_url,
            poster_url, partner_url, extra_info, notes, is_commercial, is_visible, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *""",
        sp["id"], event_id, data.role, first_topic,
        data.gift_after_speech_title, data.gift_after_speech_url,
        data.gift_raffle_title, data.gift_raffle_url,
        data.poster_url, data.partner_url, data.extra_info, data.notes,
        data.is_commercial, data.is_visible, data.sort_order
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


@router.post("/speakers/{speaker_event_id}/verify-channel", summary="Проверить подписку рабочего аккаунта на канал спикера")
async def verify_speaker_channel(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await check_conference_access(event_id, client_id, db)

    client_row = await db.fetchrow(
        "SELECT work_tg_id, work_tg_username FROM clients WHERE id = $1", client_id
    )
    if not client_row:
        raise HTTPException(status_code=404, detail="Клиент не найден")

    work_tg_id = client_row["work_tg_id"]
    if not work_tg_id:
        raise HTTPException(status_code=400, detail="Укажите ID рабочего аккаунта в настройках")

    from app.config import settings
    from app.services.channels import get_client_telegram_token
    token = (await get_client_telegram_token(client_id, db)) or settings.telegram_bot_token
    if not token:
        raise HTTPException(status_code=400, detail="Не настроен токен бота")

    row = await db.fetchrow(
        """SELECT c.tg_channel_id FROM conf_speaker_events cse
           JOIN collaborators c ON c.id = cse.speaker_id
           WHERE cse.id = $1 AND cse.event_id = $2""",
        speaker_event_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    channel_id = (row["tg_channel_id"] or "").strip()
    if not channel_id:
        raise HTTPException(status_code=400, detail="Сначала укажите ID канала спикера")

    try:
        async with httpx.AsyncClient(timeout=8) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel_id, "user_id": work_tg_id}
            )
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ошибка Telegram API: {e}")

    if not data.get("ok"):
        desc = (data.get("description") or "").lower()
        if "chat not found" in desc:
            detail = "Канал не найден. Проверьте правильность ID канала — он должен начинаться с -100."
        elif "user not found" in desc:
            detail = "Рабочий аккаунт не найден в Telegram. Проверьте ID в настройках."
        elif "bot was kicked" in desc or "kicked" in desc:
            detail = "Бот удалён из канала. Добавьте @ivision_conf_bot обратно в администраторы."
        elif "not enough rights" in desc or "no rights" in desc:
            detail = "У бота нет прав администратора в канале. Добавьте @ivision_conf_bot как администратора."
        elif "forbidden" in desc:
            detail = "Нет доступа к каналу. Убедитесь, что бот @ivision_conf_bot добавлен в администраторы."
        else:
            detail = f"Не удалось проверить канал. Попробуйте снова или проверьте ID канала."
        raise HTTPException(status_code=400, detail=detail)

    status = (data.get("result") or {}).get("status", "")
    if status not in ("member", "administrator", "creator", "restricted"):
        username = (client_row["work_tg_username"] or "").lstrip("@") or str(work_tg_id)
        raise HTTPException(
            status_code=400,
            detail=f"Рабочий аккаунт @{username} не подписан на канал. Подпишитесь и попробуйте снова."
        )

    await db.execute(
        "UPDATE conf_speaker_events SET bot_in_channel = TRUE WHERE id = $1",
        speaker_event_id
    )
    return {"ok": True, "message": "Подписка подтверждена, канал добавлен в список проверки"}


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
                  col.photo_url, col.personal_tg_username,
                  cse.role as speaker_role, cse.is_commercial,
                  cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.exclude_gift_from_broadcast
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
    # Резолв: ref_code → contacts → collaborators → conf_speaker_events
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.is_commercial, c.ref_code, cse.keyword_code,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id, sp.personal_tg_id, sp.personal_tg_username, sp.assistant_tg_username
           FROM contacts c
           JOIN collaborators sp ON sp.contact_id = c.id
           JOIN conf_speaker_events cse ON cse.speaker_id = sp.id
           WHERE c.ref_code = $1 AND cse.event_id = $2""",
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
        """SELECT cse.id, cse.speaker_id
           FROM contacts ct
           JOIN collaborators c ON c.contact_id = ct.id
           JOIN conf_speaker_events cse ON cse.speaker_id = c.id
           WHERE ct.ref_code = $1 AND cse.event_id = $2""",
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
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role, c.ref_code, cse.keyword_code,
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
           LEFT JOIN contacts c ON c.id = sp.contact_id
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
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role, c.ref_code, cse.keyword_code,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url, cse.is_commercial,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url, sp.poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id, sp.personal_tg_id, sp.personal_tg_username, sp.assistant_tg_username
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
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
    from urllib.parse import quote
    import json as _json
    await check_conference_access(event_id, int(client["sub"]), db)

    event = await db.fetchrow("SELECT * FROM events WHERE id = $1", event_id)
    conf = await db.fetchrow("SELECT * FROM conf_conferences WHERE event_id = $1", event_id)
    organizer_cse_id = conf["organizer_speaker_id"] if conf else None

    # Спикеры
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.role,
                  cse.gift_after_speech_title, cse.gift_raffle_title,
                  cse.sort_order, cse.is_visible,
                  sp.name, sp.title, sp.achievements,
                  sp.tg_channel_url, sp.tg_channel_id, sp.instagram_url
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)

    # Дни + сессии: время читаем как локальное (AT TIME ZONE 'UTC' снимает tzinfo)
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.sort_order, s.title,
                  (s.start_datetime AT TIME ZONE 'UTC') AS start_local,
                  (s.end_datetime   AT TIME ZONE 'UTC') AS end_local,
                  sp.name AS speaker_name, cse.role AS speaker_role
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, s.sort_order, s.start_datetime""",
        event_id
    )

    speakers_list = [dict(r) for r in rows]

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

    # Разбиваем спикеров на группы для каналов
    def split_by_role(sp_list, role_key="role"):
        organizer_ids = set()
        if organizer_cse_id:
            org = next((s for s in sp_list if s["id"] == organizer_cse_id), None)
            if org:
                organizer_ids.add(org["id"])
        organizers = [s for s in sp_list if s["id"] in organizer_ids]
        partners = [s for s in sp_list if s["id"] not in organizer_ids and s.get("role") == "partner"]
        others = [s for s in sp_list if s["id"] not in organizer_ids and s.get("role") != "partner"]
        return organizers, others, partners

    lines = []

    # ─── ИНФО О СПИКЕРАХ ───
    lines.append("ИНФО О СПИКЕРАХ:")
    lines.append("")

    for i, sp in enumerate(speakers_list):
        lines.append(sp["name"])

        tg = (sp.get("tg_channel_url") or "").strip()
        if tg:
            lines.append(f"Тг канал: {tg}")

        insta = (sp.get("instagram_url") or "").strip()
        if insta:
            lines.append(f"Нельзяграм: {insta}")

        if tg or insta:
            lines.append("")

        # Партнёрам тему не выводим
        if sp.get("role") != "partner":
            lines.append("Тема лекции:")
            lines.append("")

            sp_topics = topics_map.get(sp["id"], [])
            topic_texts = [t["topic"] for t in sp_topics if t["topic"].strip()]
            if topic_texts:
                for topic in topic_texts:
                    lines.append(topic)
            else:
                lines.append("уточняется")

            lines.append("")

        # Регалии из achievements · (точка по центру U+00B7)
        raw = sp.get("achievements") or []
        if isinstance(raw, str):
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
            t_start = fmt_time(s["start_local"])
            t_end = fmt_time(s["end_local"])
            time_part = f"{t_start} - {t_end}: " if (t_start or t_end) else ""
            title_part = s["title"] or ""
            sp_name = s.get("speaker_name") or ""
            sp_role = (s.get("speaker_role") or "").strip()
            role_label = {"headliner": "хедлайнер", "organizer": "организатор"}.get(sp_role, "")
            if sp_name and role_label:
                person_part = f" ({sp_name} - {role_label})"
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

    raffle_items = [(sp["name"], sp["gift_raffle_title"]) for sp in speakers_list if (sp.get("gift_raffle_title") or "").strip()]
    for idx, (sp_name, gift_title) in enumerate(raffle_items, 1):
        lines.append(f"{idx}.{gift_title} ({sp_name})")

    lines.append("")
    lines.append("—")

    # ─── КАНАЛЫ НА ПОДПИСКУ ───
    # Организаторы первыми, партнёры отдельно в конце
    organizers_sp, others_sp, partners_sp = split_by_role(speakers_list)

    lines.append("Список каналов на подписку :")
    lines.append("")

    main_channel_list = organizers_sp + others_sp
    idx = 1
    for sp in main_channel_list:
        tg = (sp.get("tg_channel_url") or "").strip()
        if tg:
            lines.append(f"{idx}.{sp['name']}: {tg}")
            idx += 1

    partner_channels = [(sp["name"], (sp.get("tg_channel_url") or "").strip()) for sp in partners_sp if (sp.get("tg_channel_url") or "").strip()]
    if partner_channels:
        lines.append("")
        lines.append("Партнёры:")
        for pidx, (sp_name, tg_url) in enumerate(partner_channels, 1):
            lines.append(f"{pidx}.{sp_name}: {tg_url}")

    lines.append("")
    lines.append("—")

    # ─── СПИСОК ID КАНАЛОВ ───
    lines.append("Список id каналов спикеров")
    lines.append("")

    idx = 1
    for sp in main_channel_list:
        ch_id = (sp.get("tg_channel_id") or "").strip()
        if ch_id:
            lines.append(f"{idx}.{sp['name']}: {ch_id}")
            idx += 1

    partner_ids = [(sp["name"], (sp.get("tg_channel_id") or "").strip()) for sp in partners_sp if (sp.get("tg_channel_id") or "").strip()]
    if partner_ids:
        lines.append("")
        lines.append("Партнёры:")
        for pidx, (sp_name, ch_id) in enumerate(partner_ids, 1):
            lines.append(f"{pidx}.{sp_name}: {ch_id}")

    text = "\n".join(lines)

    slug = event["slug"] if event and event.get("slug") else str(event_id)
    filename = f"{slug}_info.txt"
    encoded_filename = quote(filename, safe="")

    return Response(
        content=text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"}
    )


# ─── Отправка карточки спикера в Telegram ─────────────────────────────────────

def _build_speaker_caption(sp: dict, topics: list) -> str:
    """Строит текст-подпись для карточки спикера (формат Salebot, \n как разделитель)."""
    parts = []

    name = (sp.get("name") or "").strip()
    parts.append(name)

    tg = (sp.get("tg_channel_url") or "").strip()
    insta = (sp.get("instagram_url") or "").strip()
    if tg:
        parts.append(f"Тг канал: {tg}")
    if insta:
        parts.append(f"Нельзяграм: {insta}")
    if tg or insta:
        parts.append("")

    # Тема лекции (только не партнёрам)
    if sp.get("role") != "partner":
        parts.append("Тема лекции:")
        parts.append("")
        topic_texts = [t["topic"] for t in topics if t.get("topic", "").strip()]
        if topic_texts:
            for topic in topic_texts:
                parts.append(topic)
        else:
            parts.append("уточняется")
        parts.append("")

    # Регалии
    import json as _json
    raw = sp.get("achievements") or []
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except Exception:
            raw = [raw] if raw.strip() else []
    achievements_list = [a for a in raw if str(a).strip()]
    if achievements_list:
        for ach in achievements_list:
            parts.append(f"· {ach}")
    parts.append("")

    gift_speech = (sp.get("gift_after_speech_title") or "").strip()
    gift_raffle = (sp.get("gift_raffle_title") or "").strip()

    if gift_speech:
        parts.append(f"🎁 На эфире подарит: {gift_speech}")
        parts.append("")

    if gift_raffle:
        parts.append(f"🏆Подарок для большого розыгрыша: {gift_raffle}")
        parts.append("")

    return "\n".join(parts).rstrip()


@router.get("/speakers/{speaker_event_id}/send-to-telegram",
            summary="Отправить карточку спикера в Telegram (публичный, без авторизации)")
async def send_speaker_to_telegram(
    event_id: int,
    speaker_event_id: int,
    chat_id: str,
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Публичный endpoint — отправляет карточку спикера (афиша + текст) в Telegram-чат.
    chat_id — Telegram ID получателя (например, 5725111966).
    Использует bot_token из настроек клиента-владельца события.
    Вызывается из кнопок SaleBot без авторизации.
    """
    import httpx, os

    # Определяем клиента по событию
    event_row = await db.fetchrow("SELECT client_id FROM events WHERE id = $1", event_id)
    if not event_row:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    client_id = event_row["client_id"]

    # Получаем bot_token из channels (telegram-канал клиента)
    from app.services.channels import get_client_telegram_token
    bot_token = (await get_client_telegram_token(client_id, db)) or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=400, detail="bot_token не настроен в профиле клиента")

    # Данные спикера
    row = await db.fetchrow(
        """SELECT cse.id, cse.role,
                  cse.gift_after_speech_title, cse.gift_raffle_title,
                  cse.poster_url AS cse_poster_url,
                  sp.name, sp.achievements,
                  sp.photo_url, sp.poster_url,
                  sp.tg_channel_url, sp.instagram_url
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.id = $1 AND cse.event_id = $2""",
        speaker_event_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    topics_map = await _load_topics([speaker_event_id], db)
    sp = dict(row)
    topics = topics_map.get(speaker_event_id, [])

    # poster_url: сначала cse.poster_url, потом collaborators.poster_url
    poster_url = (sp.get("cse_poster_url") or sp.get("poster_url") or "").strip()
    caption = _build_speaker_caption(sp, topics)

    reply_markup = {
        "inline_keyboard": [[
            {"text": "Программа конференции", "url": "https://t.me/ivision_conf_bot?start=program"}
        ]]
    }

    CAPTION_LIMIT = 1024

    async with httpx.AsyncClient(timeout=15) as http:
        if poster_url:
            if len(caption) <= CAPTION_LIMIT:
                # Фото + caption + кнопка
                payload = {
                    "chat_id": chat_id,
                    "photo": poster_url,
                    "caption": caption,
                    "disable_web_page_preview": True,
                    "reply_markup": reply_markup,
                }
                resp = await http.post(
                    f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                    json=payload
                )
                tg_result = resp.json()
            else:
                # Фото без caption — потом текст отдельным сообщением
                resp1 = await http.post(
                    f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                    json={"chat_id": chat_id, "photo": poster_url}
                )
                tg_result = resp1.json()
                if tg_result.get("ok"):
                    resp2 = await http.post(
                        f"https://api.telegram.org/bot{bot_token}/sendMessage",
                        json={
                            "chat_id": chat_id,
                            "text": caption,
                            "disable_web_page_preview": True,
                            "reply_markup": reply_markup,
                        }
                    )
                    tg_result = resp2.json()
        else:
            payload = {
                "chat_id": chat_id,
                "text": caption,
                "disable_web_page_preview": True,
                "reply_markup": reply_markup,
            }
            resp = await http.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json=payload
            )
            tg_result = resp.json()

    if not tg_result.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка Telegram API: {tg_result.get('description', 'неизвестно')}"
        )

    return {
        "ok": True,
        "speaker": sp.get("name"),
        "chat_id": chat_id,
        "telegram_response": tg_result,
    }


# ─── Отправка программы конференции в Telegram ────────────────────────────────

SCHEDULE_ROLES_WITH_LABEL = {"headliner", "organizer", "partner", "general_partner"}

ROLE_LABELS_RU = {
    "headliner": "хедлайнер",
    "organizer": "организатор",
    "partner": "партнёр",
    "general_partner": "генеральный партнёр",
}

MONTHS_RU = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля",
    5: "мая", 6: "июня", 7: "июля", 8: "августа",
    9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
}

def _format_date_ru(d) -> str:
    if d is None:
        return ""
    if hasattr(d, "day"):
        return f"{d.day} {MONTHS_RU[d.month]}"
    return str(d)

def _fmt_time(dt) -> str:
    if dt is None:
        return "?"
    if hasattr(dt, "strftime"):
        from datetime import timezone as _tz, timedelta as _td
        # Конвертируем UTC → Moscow (UTC+3)
        if dt.tzinfo is not None:
            moscow_offset = _td(hours=3)
            dt = dt.astimezone(_tz(moscow_offset))
        return dt.strftime("%H:%M")
    return str(dt)

def _build_schedule_text(days_data: list) -> str:
    """Строит текст программы конференции с HTML-разметкой для Telegram."""
    lines = ["ПРОГРАММА КОНФЕРЕНЦИИ:"]
    for day in days_data:
        lines.append("")
        date_label = day["date"]
        day_header = f"ДЕНЬ {day['day_number']} - {date_label}" if date_label else f"ДЕНЬ {day['day_number']}"
        lines.append(f"<b>{day_header}</b>")
        for s in day["sessions"]:
            time_start = s["time_start"]
            time_end = s["time_end"]
            title = s["title"]
            speaker = s["speaker_name"] or ""
            role = s["role"] or ""
            line = f"<b>{time_start} - {time_end}</b>: {title}"
            if speaker:
                if role in SCHEDULE_ROLES_WITH_LABEL:
                    role_label = ROLE_LABELS_RU.get(role, role)
                    line += f" (<b>{speaker}</b> - {role_label})"
                else:
                    line += f" (<b>{speaker}</b>)"
            lines.append(line)
    return "\n".join(lines)


@router.get(
    "/send-schedule",
    summary="Отправить программу конференции в Telegram",
    tags=["Конференция"],
)
async def send_schedule_to_telegram(
    event_id: int,
    chat_id: int,
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Публичный GET endpoint.
    Параметры: event_id (path), chat_id (query).
    Отправляет текст программы конференции с тремя inline-кнопками в Telegram.
    bot_token берётся из таблицы clients по client_id события.
    """
    import httpx, os

    # Получаем client_id из события
    event_row = await db.fetchrow("SELECT client_id FROM events WHERE id = $1", event_id)
    if not event_row:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    client_id = event_row["client_id"]

    # bot_token из channels (telegram-канал клиента)
    from app.services.channels import get_client_telegram_token
    bot_token = (await get_client_telegram_token(client_id, db)) or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=400, detail="bot_token не настроен в профиле клиента")

    # Данные конференции (для ссылки)
    conf = await db.fetchrow(
        "SELECT registration_url, getcourse_form_url FROM conf_conferences WHERE event_id = $1",
        event_id
    )
    conf_url = ""
    if conf:
        conf_url = (conf["registration_url"] or conf["getcourse_form_url"] or "").strip()

    # Дни конференции
    days_db = await db.fetch(
        "SELECT day_number, day_date FROM conf_days WHERE event_id = $1 ORDER BY day_number",
        event_id
    )

    # Сессии с ролью
    sessions_db = await db.fetch(
        """SELECT s.day, s.start_datetime, s.end_datetime, s.title, s.sort_order,
                  sp.name AS speaker_name, cse.role
           FROM conf_sessions s
           LEFT JOIN conf_speaker_events cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, s.sort_order, s.start_datetime""",
        event_id
    )

    # Группируем сессии по дням
    sessions_by_day: dict = {}
    for s in sessions_db:
        d = s["day"]
        sessions_by_day.setdefault(d, []).append(s)

    days_data = []
    for day in days_db:
        dn = day["day_number"]
        days_data.append({
            "day_number": dn,
            "date": _format_date_ru(day["day_date"]),
            "sessions": [
                {
                    "time_start": _fmt_time(s["start_datetime"]),
                    "time_end": _fmt_time(s["end_datetime"]),
                    "title": s["title"],
                    "speaker_name": s["speaker_name"],
                    "role": s["role"],
                }
                for s in sessions_by_day.get(dn, [])
            ],
        })

    text = _build_schedule_text(days_data)

    # Inline-кнопки
    buttons = [
        [{"text": "ИНФОРМАЦИЯ О СПИКЕРАХ", "url": "https://t.me/ivision_conf_bot?start=spikers"}],
    ]
    if conf_url:
        buttons.append([{"text": "ПОЛУЧИТЬ ЗАПИСИ И VIP-ТАРИФ", "url": conf_url}])
        buttons.append([{"text": "ЗАРЕГИСТРИРОВАТЬСЯ", "url": conf_url}])

    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_markup": {"inline_keyboard": buttons},
    }

    SCHEDULE_IMAGE_URL = "https://pub-519fc43b54e1489384397c9cea0c0ded.r2.dev/img/ivision_program.jpg"

    async with httpx.AsyncClient(timeout=15) as http:
        # Сначала отправляем изображение без текста
        photo_resp = await http.post(
            f"https://api.telegram.org/bot{bot_token}/sendPhoto",
            json={"chat_id": chat_id, "photo": SCHEDULE_IMAGE_URL},
        )
        photo_result = photo_resp.json()
        if not photo_result.get("ok"):
            raise HTTPException(
                status_code=502,
                detail=f"Ошибка отправки фото: {photo_result.get('description', 'неизвестно')}",
            )

        # Затем текст программы с кнопками
        resp = await http.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json=payload,
        )
        tg_result = resp.json()

    if not tg_result.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка Telegram API: {tg_result.get('description', 'неизвестно')}",
        )

    return {
        "ok": True,
        "chat_id": chat_id,
        "days": len(days_data),
        "telegram_response": tg_result,
    }


# ─── Отправка списка подарков для розыгрыша в Telegram ───────────────────────

RAFFLE_ROLES_WITH_LABEL = {"headliner", "organizer", "partner", "general_partner"}

RAFFLE_ROLE_LABELS_RU = {
    "headliner": "хедлайнер",
    "organizer": "организатор",
    "partner": "партнёр",
    "general_partner": "генеральный партнёр",
}

@router.get(
    "/send-raffle-gifts",
    summary="Отправить список подарков розыгрыша в Telegram",
    tags=["Конференция"],
)
async def send_raffle_gifts_to_telegram(
    event_id: int,
    chat_id: int,
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Публичный GET endpoint.
    Параметры: event_id (path), chat_id (query).
    Отправляет нумерованный список подарков для розыгрыша с кнопкой в Telegram.
    bot_token берётся из таблицы clients по client_id события.
    """
    import httpx, os

    # Получаем client_id из события
    event_row = await db.fetchrow("SELECT client_id FROM events WHERE id = $1", event_id)
    if not event_row:
        raise HTTPException(status_code=404, detail="Событие не найдено")
    client_id = event_row["client_id"]

    # bot_token из channels (telegram-канал клиента)
    from app.services.channels import get_client_telegram_token
    bot_token = (await get_client_telegram_token(client_id, db)) or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not bot_token:
        raise HTTPException(status_code=400, detail="bot_token не настроен в профиле клиента")

    # Подарки для розыгрыша — только те у кого заполнен gift_raffle_title
    gifts = await db.fetch(
        """SELECT cse.gift_raffle_title, cse.role, sp.name
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
             AND cse.gift_raffle_title IS NOT NULL
             AND cse.gift_raffle_title != ''
             AND cse.is_visible = TRUE
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )

    if not gifts:
        raise HTTPException(status_code=404, detail="Подарки для розыгрыша не найдены")

    lines = []
    for i, g in enumerate(gifts, 1):
        gift_title = g["gift_raffle_title"]
        speaker = g["name"] or ""
        role = g["role"] or ""
        if speaker:
            if role in RAFFLE_ROLES_WITH_LABEL:
                role_label = RAFFLE_ROLE_LABELS_RU.get(role, role)
                speaker_part = f"<b>{speaker} - {role_label}</b>"
            else:
                speaker_part = f"<b>{speaker}</b>"
            lines.append(f"{i}.{gift_title} ({speaker_part})")
        else:
            lines.append(f"{i}.{gift_title}")

    text = "\n\n".join(lines)

    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_markup": {
            "inline_keyboard": [[
                {"text": "Проверить/Получить билеты", "url": "https://t.me/ivision_conf_bot?start=check_get_bilets"}
            ]]
        },
    }

    async with httpx.AsyncClient(timeout=15) as http:
        resp = await http.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json=payload,
        )
        tg_result = resp.json()

    if not tg_result.get("ok"):
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка Telegram API: {tg_result.get('description', 'неизвестно')}",
        )

    return {
        "ok": True,
        "chat_id": chat_id,
        "gifts_count": len(gifts),
        "telegram_response": tg_result,
    }


# ─── Билеты розыгрыша ─────────────────────────────────────────────────────────

class RaffleTicketPublicCreate(BaseModel):
    ticket_number: int
    tg_username: Optional[str] = None
    tg_id: Optional[int] = None
    tg_name: Optional[str] = None
    salebot_client_id: Optional[str] = None
    code_word: Optional[str] = None


@router.get("/raffle-tickets", summary="Список билетов розыгрыша")
async def list_raffle_tickets(
    event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    tickets = await db.fetch(
        """SELECT rt.*,
                  pu.username  AS pu_username,
                  pu.first_name AS pu_first_name,
                  pu.last_name  AS pu_last_name,
                  c.salebot_id AS pu_salebot_id
             FROM conf_raffle_tickets rt
        LEFT JOIN event_participants ep ON ep.id = rt.pluson_participant_id
        LEFT JOIN contacts           c  ON c.id = ep.contact_id
        LEFT JOIN platform_users     pu ON pu.contact_id = c.id AND pu.platform_slug = 'telegram'
            WHERE rt.event_id = $1
         ORDER BY rt.ticket_number""",
        event_id
    )
    return {"tickets": [dict(t) for t in tickets]}


@router.post("/raffle-tickets/public", summary="Добавить билет (публичный, без авторизации)")
async def add_raffle_ticket_public(
    event_id: int, data: RaffleTicketPublicCreate, db: asyncpg.Connection = Depends(get_db)
):
    # Проверяем что событие существует и является конференцией
    event = await db.fetchrow(
        "SELECT id, client_id FROM events WHERE id = $1 AND module_slug = 'conference'", event_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Конференция не найдена")

    # Ищем pluson_participant_id: сначала по tg_id (platform_user_id в platform_users),
    # затем по salebot_client_id (поле salebot_id в contacts)
    pluson_participant_id = None
    if data.tg_id:
        pluson_participant_id = await db.fetchval(
            """SELECT ep.id FROM event_participants ep
               JOIN platform_users pu ON pu.contact_id = ep.contact_id
               WHERE pu.platform_slug = 'telegram'
                 AND pu.platform_user_id = $1
                 AND ep.event_id = $2""",
            str(data.tg_id), event_id
        )
    if not pluson_participant_id and data.salebot_client_id:
        pluson_participant_id = await db.fetchval(
            """SELECT ep.id FROM event_participants ep
               JOIN contacts c ON c.id = ep.contact_id
               WHERE c.salebot_id = $1 AND ep.event_id = $2""",
            data.salebot_client_id, event_id
        )

    try:
        ticket = await db.fetchrow(
            """INSERT INTO conf_raffle_tickets
               (event_id, ticket_number, tg_username, tg_id, tg_name, salebot_client_id, pluson_participant_id, code_word)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (event_id, ticket_number) DO UPDATE SET
                 tg_username = EXCLUDED.tg_username,
                 tg_id = EXCLUDED.tg_id,
                 tg_name = EXCLUDED.tg_name,
                 salebot_client_id = EXCLUDED.salebot_client_id,
                 pluson_participant_id = EXCLUDED.pluson_participant_id,
                 code_word = EXCLUDED.code_word
               RETURNING *""",
            event_id, data.ticket_number, data.tg_username, data.tg_id,
            data.tg_name, data.salebot_client_id, pluson_participant_id, data.code_word
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ─── Отчёты конференции ────────────────────────────────────────────────────────

class ReportCreate(BaseModel):
    announcements: int = 0


@router.post("/reports", summary="Создать отчёт (снимок статистики)")
async def create_report(
    event_id: int,
    data: ReportCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    # Все спикеры/организаторы конференции с трафиком по реф-коду
    # ref_code теперь живёт в contacts (через collaborators.contact_id)
    speakers_rows = await db.fetch(
        """SELECT cse.id AS speaker_event_id, cse.speaker_id, c.ref_code,
                  cse.role, cse.is_commercial, cse.sort_order,
                  col.name, col.personal_tg_username AS username,
                  COUNT(ep.id) FILTER (WHERE ep.id IS NOT NULL) AS entered,
                  COUNT(ep.id) FILTER (WHERE ep.is_registered = TRUE) AS registered
           FROM conf_speaker_events cse
           JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = col.contact_id
           LEFT JOIN event_participants ep ON ep.event_id = $1
               AND ep.referrer_ref_code = c.ref_code
           WHERE cse.event_id = $1
           GROUP BY cse.id, cse.speaker_id, c.ref_code, cse.role,
                    cse.is_commercial, cse.sort_order, col.name, col.personal_tg_username
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )

    # Реф-коды всех спикеров/организаторов — для исключения из рефералов и базы
    all_speaker_ref_codes = {row["ref_code"] for row in speakers_rows if row["ref_code"]}

    speakers_data = []
    for row in speakers_rows:
        speakers_data.append({
            "speaker_event_id": row["speaker_event_id"],
            "speaker_id": row["speaker_id"],
            "name": row["name"] or "",
            "username": row["username"] or "",
            "role": row["role"] or "speaker",
            "is_commercial": row["is_commercial"] or False,
            "ref_code": row["ref_code"] or "",
            "entered": int(row["entered"]),
            "registered": int(row["registered"]),
        })

    # Группа «Ошибка распределения» больше не существует:
    # маркер 'new_partner_id' зачищен, такие участники теперь идут в «Из базы».
    errors_rows = []

    errors_data = []
    for row in errors_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or str(row["tg_id"] or "")
        errors_data.append({
            "participant_id": row["id"],
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": 1,
            "registered": 1 if row["is_registered"] else 0,
        })

    # Рефоводы = те кто привёл других И сами являются участниками события
    # Исключаем спикеров через JOIN: спикер — это коллаб со связкой на contact, и есть запись в conf_speaker_events
    referrals_rows = await db.fetch(
        """SELECT ep2.referrer_ref_code,
                  COUNT(ep2.id) AS entered,
                  COUNT(ep2.id) FILTER (WHERE ep2.is_registered = TRUE) AS registered,
                  pu.platform_user_id AS tg_id, pu.first_name, pu.last_name, pu.username, ct.id AS contact_id
           FROM event_participants ep2
           JOIN contacts ct ON ct.ref_code = ep2.referrer_ref_code AND ct.client_id = (
               SELECT client_id FROM events WHERE id = $1
           )
           LEFT JOIN platform_users pu ON pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
           WHERE ep2.event_id = $1
             AND ep2.referrer_ref_code IS NOT NULL
             AND ep2.referrer_ref_code <> ''
             AND NOT EXISTS (
                 SELECT 1 FROM collaborators c
                 JOIN conf_speaker_events cse ON cse.speaker_id = c.id
                 WHERE c.contact_id = ct.id AND cse.event_id = $1
             )
             AND EXISTS (
                 SELECT 1 FROM event_participants ep_check
                 WHERE ep_check.contact_id = ct.id AND ep_check.event_id = $1
             )
           GROUP BY ep2.referrer_ref_code, pu.platform_user_id, pu.first_name, pu.last_name, pu.username, ct.id
           ORDER BY entered DESC""",
        event_id
    )

    referrals_data = []
    for row in referrals_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or row["referrer_ref_code"] or "—"
        referrals_data.append({
            "participant_id": row["contact_id"] or 0,
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": int(row["entered"]),
            "registered": int(row["registered"]),
        })

    # Из базы: 1) участники без реф-кода, 2) рефоводы не являющиеся участниками события
    base_rows = await db.fetch(
        """SELECT ep.id, ep.is_registered,
                  pu.platform_user_id AS tg_id, pu.first_name, pu.last_name, pu.username
           FROM event_participants ep
           JOIN contacts ct ON ct.id = ep.contact_id
           LEFT JOIN platform_users pu ON pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
           WHERE ep.event_id = $1
             AND (ep.referrer_ref_code IS NULL OR ep.referrer_ref_code = '')
           ORDER BY ep.id""",
        event_id
    )

    # Рефоводы не являющиеся участниками события — тоже идут в базу
    # (исключаем спикеров через JOIN на collaborators)
    base_referrers_rows = await db.fetch(
        """SELECT ep2.referrer_ref_code,
                  COUNT(ep2.id) AS entered,
                  COUNT(ep2.id) FILTER (WHERE ep2.is_registered = TRUE) AS registered,
                  pu.platform_user_id AS tg_id, pu.first_name, pu.last_name, pu.username, ct.id AS contact_id
           FROM event_participants ep2
           JOIN contacts ct ON ct.ref_code = ep2.referrer_ref_code AND ct.client_id = (
               SELECT client_id FROM events WHERE id = $1
           )
           LEFT JOIN platform_users pu ON pu.contact_id = ct.id AND pu.platform_slug = 'telegram'
           WHERE ep2.event_id = $1
             AND ep2.referrer_ref_code IS NOT NULL
             AND ep2.referrer_ref_code <> ''
             AND NOT EXISTS (
                 SELECT 1 FROM collaborators c
                 JOIN conf_speaker_events cse ON cse.speaker_id = c.id
                 WHERE c.contact_id = ct.id AND cse.event_id = $1
             )
             AND NOT EXISTS (
                 SELECT 1 FROM event_participants ep_check
                 WHERE ep_check.contact_id = ct.id AND ep_check.event_id = $1
             )
           GROUP BY ep2.referrer_ref_code, pu.platform_user_id, pu.first_name, pu.last_name, pu.username, ct.id
           ORDER BY entered DESC""",
        event_id
    )

    base_data = []
    for row in base_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or str(row["tg_id"] or "")
        base_data.append({
            "participant_id": row["id"],
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": 1,
            "registered": 1 if row["is_registered"] else 0,
        })
    for row in base_referrers_rows:
        name_parts = [row["first_name"] or "", row["last_name"] or ""]
        name = " ".join(p for p in name_parts if p).strip() or row["username"] or str(row["tg_id"] or "")
        base_data.append({
            "participant_id": row["contact_id"] or 0,
            "name": name,
            "username": row["username"] or "",
            "tg_id": str(row["tg_id"] or ""),
            "entered": int(row["entered"]),
            "registered": int(row["registered"]),
        })

    # Сводные цифры
    speakers_entered = sum(s["entered"] for s in speakers_data)
    speakers_registered = sum(s["registered"] for s in speakers_data)
    referrals_entered = sum(r["entered"] for r in referrals_data)
    referrals_registered = sum(r["registered"] for r in referrals_data)
    base_entered = sum(r["entered"] for r in base_data)
    base_registered = sum(r["registered"] for r in base_data)
    errors_entered = len(errors_data)
    errors_registered = sum(r["registered"] for r in errors_data)
    total_entered = speakers_entered + referrals_entered + base_entered + errors_entered
    total_registered = speakers_registered + referrals_registered + base_registered + errors_registered

    report = await db.fetchrow(
        """INSERT INTO conf_reports
           (event_id, announcements, total_entered, total_registered,
            speakers_entered, speakers_registered,
            referrals_entered, referrals_registered,
            speakers_data, referrals_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *""",
        event_id, data.announcements,
        total_entered, total_registered,
        speakers_entered, speakers_registered,
        referrals_entered + base_entered, referrals_registered + base_registered,
        json.dumps(speakers_data, ensure_ascii=False),
        json.dumps({
            "referrals": referrals_data,
            "base": base_data,
            "errors": errors_data,
        }, ensure_ascii=False),
    )

    return {"report": dict(report)}


@router.get("/reports", summary="Список отчётов конференции")
async def list_reports(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    rows = await db.fetch(
        """SELECT id, event_id, created_at, announcements,
                  total_entered, total_registered,
                  speakers_entered, speakers_registered,
                  referrals_entered, referrals_registered
           FROM conf_reports
           WHERE event_id = $1
           ORDER BY created_at DESC""",
        event_id
    )

    return {"reports": [dict(r) for r in rows]}


@router.get("/reports/{report_id}", summary="Детальный отчёт")
async def get_report(
    event_id: int,
    report_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    row = await db.fetchrow(
        "SELECT * FROM conf_reports WHERE id = $1 AND event_id = $2",
        report_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Отчёт не найден")

    r = dict(row)
    if isinstance(r.get("speakers_data"), str):
        r["speakers_data"] = json.loads(r["speakers_data"])
    raw_ref = r.get("referrals_data")
    if isinstance(raw_ref, str):
        raw_ref = json.loads(raw_ref)
    # Поддержка старого формата (список) и нового (dict с ключами referrals/base/errors)
    if isinstance(raw_ref, list):
        r["referrals_data"] = raw_ref
        r["base_data"] = []
        r["errors_data"] = []
    else:
        r["referrals_data"] = raw_ref.get("referrals", [])
        r["base_data"] = raw_ref.get("base", [])
        r["errors_data"] = raw_ref.get("errors", [])

    return {"report": r}


@router.delete("/reports/{report_id}", summary="Удалить отчёт")
async def delete_report(
    event_id: int,
    report_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)

    deleted = await db.fetchval(
        "DELETE FROM conf_reports WHERE id = $1 AND event_id = $2 RETURNING id",
        report_id, event_id
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Отчёт не найден")
    return {"ok": True}

    return {"ok": True, "ticket": dict(ticket)}
