from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
from app.services import collaborator_sort
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


_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def _normalize_hhmm(val):
    """Принимает ввод времени "HH:MM" (или ISO с временем), возвращает строку "HH:MM" либо None."""
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    # Если прилетел ISO datetime — берём час:минута часть напрямую (без TZ-математики).
    if "T" in s:
        s = s.split("T", 1)[1][:5]
    elif len(s) > 5 and s[2] == ":":
        s = s[:5]
    if not _HHMM_RE.match(s):
        raise HTTPException(status_code=422, detail=f"Время должно быть в формате HH:MM, получено: {val!r}")
    return s


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
      (генерим если NULL — но в новой схеме ref_code обязателен при создании contacts).
    - Иначе создаём contact (с уникальным ref_code) и привязываем его к collaborator.

    Личный TG спикера живёт в platform_users (миграция 107) — апсертится отдельно
    через CollaboratorCreate/Update + _upsert_personal_tg в collaborators.py.
    """
    from app.services.contact_merge import _generate_unique_ref_code

    coll = await db.fetchrow(
        "SELECT id, created_by_client_id, contact_id, name FROM collaborators WHERE id = $1",
        collaborator_id
    )
    if not coll:
        raise HTTPException(status_code=404, detail="Коллаборатор не найден")

    contact_id = coll["contact_id"]

    if not contact_id:
        ref_code = await _generate_unique_ref_code(db)
        contact_id = await db.fetchval(
            """INSERT INTO contacts (client_id, name, ref_code, is_active, tags, merged_ref_codes)
               VALUES ($1, $2, $3, TRUE, '[]'::JSONB, '[]'::JSONB)
               RETURNING id""",
            coll["created_by_client_id"], coll["name"], ref_code
        )
        await db.execute(
            "UPDATE collaborators SET contact_id = $1 WHERE id = $2",
            contact_id, coll["id"]
        )
    else:
        ref_code = await db.fetchval("SELECT ref_code FROM contacts WHERE id = $1", contact_id)
        if not ref_code:
            ref_code = await _generate_unique_ref_code(db)
            await db.execute("UPDATE contacts SET ref_code = $1 WHERE id = $2", ref_code, contact_id)

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
           FROM event_collaborators cse
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
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1 ORDER BY s.day, s.sort_order, s.start_time""",
        event_id
    )
    # Афиши — единый источник истины event_posters
    posters_rows = await db.fetch(
        """SELECT url, orientation FROM event_posters
            WHERE event_id = $1 ORDER BY sort, id""",
        event_id
    )
    poster_horizontal = [p["url"] for p in posters_rows if p["orientation"] == "horizontal"]
    poster_vertical   = [p["url"] for p in posters_rows if p["orientation"] == "vertical"]
    poster_square     = [p["url"] for p in posters_rows if p["orientation"] == "square"]

    def dt_str(val):
        # Время теперь хранится как строка "HH:MM" — отдаём её прямо.
        if val is None or val == "":
            return None
        return str(val)[:5]

    def date_str(val):
        if val is None:
            return None
        if isinstance(val, date):
            return val.strftime("%-d %B %Y года")
        return str(val)

    # Stream_url теперь один на всю конференцию (events.stream_url),
    # но для обратной совместимости лендинга прокидываем его в каждый день.
    event_stream_url = (event["stream_url"] if event and "stream_url" in event else "") or ""

    schedule = []
    for d in days:
        day_sessions = [s for s in sessions if s["day"] == d["day_number"]]
        schedule.append({
            "day": f"День {d['day_number']}",
            "date": date_str(d["day_date"]),
            "stream_url": event_stream_url,
            "slots": [
                {
                    "time": dt_str(s["start_time"]),
                    "time_end": dt_str(s["end_time"]),
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
        "description": (event["description"] if event else "") or "",
        "registration_url": (event["landing_url"] if event else None) or conf["getcourse_form_url"] or "",
        "chat_url": (event["chat_url"] if event else None) or conf["chat_url"] or "",
        "stream_url": event_stream_url,
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
        "poster_horizontal": poster_horizontal,
        "poster_vertical": poster_vertical,
        "poster_square": poster_square,
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
    # description перенесён в events.description (миграция 092). Поле живёт
    # на уровне события, конференции/турниры используют то же поле.
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    landing_url: Optional[str] = None
    landing_template: Optional[str] = None
    # chat_url, stream_url, vip_url пишутся в events, не conf_conferences —
    # источник истины один. Оставлены здесь как поля, чтобы фронт мог
    # отправить их в одном PATCH со всеми остальными настройками.
    chat_url: Optional[str] = None
    chat_url_tg: Optional[str] = None
    chat_url_vk: Optional[str] = None
    chat_url_max: Optional[str] = None
    primary_chat_platform: Optional[str] = None   # 'telegram' | 'vk' | 'max'
    stream_url: Optional[str] = None
    vip_url: Optional[str] = None
    vip_button_label: Optional[str] = None
    chat_button_label: Optional[str] = None        # заголовок кнопки чата (миграция 117)
    accent_button: Optional[str] = None            # 'vip' | 'chat' | 'none' (миграция 117)
    getcourse_form_url: Optional[str] = None
    require_speakers_sub: Optional[bool] = None
    subscription_mode: Optional[str] = None   # none | organizer | all_speakers
    is_live: Optional[bool] = None
    status: Optional[str] = None
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
        SELECT cc.*, e.title as event_title,
               e.slug        AS event_slug,
               e.status      AS event_status,
               e.chat_url    AS event_chat_url,
               e.chat_url_tg  AS event_chat_url_tg,
               e.chat_url_vk  AS event_chat_url_vk,
               e.chat_url_max AS event_chat_url_max,
               e.primary_chat_platform AS event_primary_chat_platform,
               e.stream_url  AS event_stream_url,
               e.vip_url     AS event_vip_url,
               e.vip_button_label AS event_vip_button_label,
               e.chat_button_label AS event_chat_button_label,
               e.accent_button AS event_accent_button,
               e.landing_url AS event_landing_url,
               e.telegram_chat_ids AS event_telegram_chat_ids
        FROM conf_conferences cc
        JOIN events e ON e.id = cc.event_id
        WHERE cc.event_id = $1
        """,
        event_id
    )
    if not conf:
        return {"conference": None}
    d = dict(conf)
    # chat_url / stream_url / vip_url / landing_url / telegram_chat_ids — единый
    # источник истины events (миграция 076 для telegram_chat_ids).
    d["chat_url"]      = d.pop("event_chat_url")     or d.get("chat_url") or ""
    d["chat_url_tg"]   = d.pop("event_chat_url_tg")  or ""
    d["chat_url_vk"]   = d.pop("event_chat_url_vk")  or ""
    d["chat_url_max"]  = d.pop("event_chat_url_max") or ""
    d["primary_chat_platform"] = d.pop("event_primary_chat_platform") or None
    d["stream_url"] = d.pop("event_stream_url") or ""
    d["vip_url"]    = d.pop("event_vip_url")    or ""
    d["vip_button_label"] = d.pop("event_vip_button_label") or ""
    d["chat_button_label"] = d.pop("event_chat_button_label") or ""
    d["accent_button"]     = d.pop("event_accent_button") or None
    d["telegram_chat_ids"] = d.pop("event_telegram_chat_ids") or ""
    # event_landing_url — для шаблонов рассылок и превью; conf_conferences.landing_url
    # (если осталось) — это устаревший шаблон встроенного лендинга, не путать.
    d["event_landing_url"] = d.pop("event_landing_url") or ""
    return {"conference": d}


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

    raw = data.model_dump(exclude_unset=True)
    # Поля, которые живут в events (не в conf_conferences) — единый источник истины.
    EVENT_FIELDS = (
        "chat_url", "chat_url_tg", "chat_url_vk", "chat_url_max",
        "primary_chat_platform",
        "stream_url", "vip_url", "vip_button_label",
        "chat_button_label", "accent_button",
        "telegram_chat_ids",
    )
    sent = data.model_dump(exclude_unset=True)
    event_updates: dict = {}
    for f in EVENT_FIELDS:
        if f in raw:
            val = raw.pop(f)
            # Для строковых *_url полей нормализуем пустую строку в NULL
            if f in ("vip_url", "vip_button_label") and isinstance(val, str):
                val = val.strip() or None
            event_updates[f] = val

    if raw:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(raw.keys())]
        await db.execute(
            f"UPDATE conf_conferences SET {', '.join(set_parts)} WHERE event_id = $1",
            event_id, *raw.values()
        )

    if event_updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE events SET {', '.join(set_parts)} WHERE id = $1",
            event_id, *event_updates.values()
        )
        # chat_url — legacy shadow. После UPDATE chat_url_* / primary
        # пересчитываем chat_url = chat_url_<primary>.
        if any(k in event_updates for k in ("chat_url_tg", "chat_url_vk", "chat_url_max", "primary_chat_platform")):
            from ..events import _refresh_chat_url_shadow
            await _refresh_chat_url_shadow(db, event_id)

    await regenerate_landing_data(event_id, db)
    # Возвращаем тот же обогащённый объект что и в GET /conference/ —
    # с подменой chat_url/stream_url/vip_url/event_landing_url из events.
    # Иначе frontend в SettingsTab перезаливает state из response и теряет
    # эти поля (они не лежат в conf_conferences).
    conf = await db.fetchrow(
        """
        SELECT cc.*, e.title AS event_title,
               e.chat_url    AS event_chat_url,
               e.chat_url_tg  AS event_chat_url_tg,
               e.chat_url_vk  AS event_chat_url_vk,
               e.chat_url_max AS event_chat_url_max,
               e.primary_chat_platform AS event_primary_chat_platform,
               e.stream_url  AS event_stream_url,
               e.vip_url     AS event_vip_url,
               e.vip_button_label AS event_vip_button_label,
               e.chat_button_label AS event_chat_button_label,
               e.accent_button AS event_accent_button,
               e.landing_url AS event_landing_url,
               e.telegram_chat_ids AS event_telegram_chat_ids
        FROM conf_conferences cc
        JOIN events e ON e.id = cc.event_id
        WHERE cc.event_id = $1
        """,
        event_id,
    )
    d = dict(conf)
    d["chat_url"]          = d.pop("event_chat_url")   or d.get("chat_url") or ""
    d["chat_url_tg"]       = d.pop("event_chat_url_tg")  or ""
    d["chat_url_vk"]       = d.pop("event_chat_url_vk")  or ""
    d["chat_url_max"]      = d.pop("event_chat_url_max") or ""
    d["primary_chat_platform"] = d.pop("event_primary_chat_platform") or None
    d["stream_url"]        = d.pop("event_stream_url") or ""
    d["vip_url"]           = d.pop("event_vip_url")    or ""
    d["vip_button_label"]  = d.pop("event_vip_button_label") or ""
    d["chat_button_label"] = d.pop("event_chat_button_label") or ""
    d["accent_button"]     = d.pop("event_accent_button") or None
    d["event_landing_url"] = d.pop("event_landing_url") or ""
    d["telegram_chat_ids"] = d.pop("event_telegram_chat_ids") or ""
    return {"conference": d}


@router.post("/regenerate-landing", summary="Пересобрать JSON лендинга")
async def regenerate_landing(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    data = await regenerate_landing_data(event_id, db)
    return {"landing_data": data, "message": "JSON лендинга обновлён"}


# ─── Спикеры события (event_collaborators) ────────────────────────────────────
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
    # Какая афиша из библиотеки коллаба используется в этом событии
    # (для рассылок, виджетов, Mini App). NULL = первая из библиотеки.
    poster_id: Optional[int] = None
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    notes: Optional[str] = None
    is_commercial: bool = False
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
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    # Личные идентичности — пишутся в platform_users (миграции 107/108).
    # Обязательна минимум одна из платформ — валидация в обработчике.
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    # Данные участия в этом событии
    role: str = "speaker"
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    # poster_id выбирается в карточке спикера после создания (тут нет
    # библиотеки афиш, потому что коллаб только что родился).
    partner_url: Optional[str] = None
    extra_info: Optional[str] = None
    notes: Optional[str] = None
    is_commercial: bool = False
    is_visible: bool = True
    sort_order: int = 0
    # Дедуп по имени: если у клиента уже есть контакт с таким именем —
    # без force_create эндпоинт вернёт needs_choice с вариантами для UI.
    # Если клиент выбрал «привязать к существующему» — передаёт existing_contact_id.
    force_create: bool = False
    existing_contact_id: Optional[int] = None


class SpeakerEventUpdate(BaseModel):
    """Обновить данные участия спикера в событии (тема, подарок, роль и т.д.)"""
    role: Optional[str] = None
    speaker_topic: Optional[str] = None  # устаревшее, оставлено для совместимости
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None
    show_topic_field: Optional[bool] = None
    show_gift_after_speech_field: Optional[bool] = None
    show_knowledge_base_field: Optional[bool] = None
    # Какая афиша из библиотеки коллаба используется в этом событии для
    # рассылок бота (speaker_intro / 5min_before / gift). NULL = первая
    # из библиотеки. См. миграцию 121.
    poster_id: Optional[int] = None
    # Какие афиши из библиотеки коллаба отмечены «для анонсов» в этом событии.
    # Видны спикеру в его кабинете в разделе «Афиши для анонсов» —
    # скачивает и постит в своих каналах. Множественный выбор. Миграция 122.
    announcement_poster_ids: Optional[List[int]] = None
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
    """Объединяет данные из speakers + event_collaborators в один объект."""
    d = dict(row)
    return d


async def _load_topics(cse_ids: list, db) -> dict:
    """Загружает темы для списка event_collaborators.id. Возвращает {cse_id: [{id, topic}, ...]}."""
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
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  cse.show_topic_field, cse.show_gift_after_speech_field,
                  cse.show_knowledge_base_field,
                  cse.poster_id,
                  cse.announcement_poster_ids,
                  cp_cse.url AS cse_poster_url,
                  cse.partner_url, cse.extra_info, cse.notes,
                  c.ref_code, cse.is_visible, cse.sort_order, cse.is_commercial,
                  cse.bot_in_channel, cse.priority,
                  cse.exclude_gift_from_broadcast, cse.exclude_channel_from_subscription,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS speaker_poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.vk_url, sp.max_url,
                  sp.instagram_url, sp.website_url,
                  sp.access_code,
                  pu_tg.username AS personal_tg_username,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_vk.username AS personal_vk_username,
                  pu_vk.platform_user_id AS personal_vk_id,
                  pu_max.username AS personal_max_username,
                  pu_max.platform_user_id AS personal_max_id
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN collaborator_posters cp_cse ON cp_cse.id = cse.poster_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           LEFT JOIN platform_users pu_vk
             ON pu_vk.contact_id = sp.contact_id AND pu_vk.platform_slug = 'vk'
           LEFT JOIN platform_users pu_max
             ON pu_max.contact_id = sp.contact_id AND pu_max.platform_slug = 'max'
           WHERE cse.event_id = $1
           ORDER BY """ + collaborator_sort.order_by_sql("cse"),
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)
    result = []
    for r in rows:
        d = dict(r)
        d["topics"] = topics_map.get(d["id"], [])
        d["poster_url"] = d.get("cse_poster_url") or d.get("speaker_poster_url")
        result.append(d)
    return {"speakers": result}


@router.get("/speakers/public", summary="Спикеры для Mini App")
async def list_event_speakers_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.role, cse.speaker_topic,
                  cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url, cse.sort_order,
                  cse.knowledge_base_title, cse.knowledge_base_url,
                  sp.name, sp.title, sp.photo_url,
                  sp.tg_channel_url, sp.vk_url, sp.max_url, sp.instagram_url,
                  sp.achievements,
                  pu_tg.username AS personal_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.event_id = $1 AND cse.is_visible = TRUE
           ORDER BY """ + collaborator_sort.order_by_sql("cse"),
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
                  cse.poster_id,
                  cp_cse.url AS event_poster_url,
                  cse.is_commercial,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN collaborator_posters cp_cse ON cp_cse.id = cse.poster_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
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
        "SELECT id FROM event_collaborators WHERE speaker_id = $1 AND event_id = $2",
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

    # poster_id если передан — проверим что принадлежит этому коллабу
    if data.poster_id is not None:
        belongs = await db.fetchval(
            "SELECT 1 FROM collaborator_posters WHERE id = $1 AND collaborator_id = $2",
            data.poster_id, data.speaker_id,
        )
        if not belongs:
            raise HTTPException(status_code=400, detail="poster_id не из библиотеки этого коллаба")
    cse = await db.fetchrow(
        """INSERT INTO event_collaborators
           (speaker_id, event_id, role, speaker_topic, gift_after_speech_title, gift_after_speech_url,
            gift_raffle_title, gift_raffle_url,
            poster_id, partner_url, extra_info, notes, is_commercial, is_visible, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *""",
        data.speaker_id, event_id, data.role, first_topic,
        data.gift_after_speech_title, data.gift_after_speech_url,
        data.gift_raffle_title, data.gift_raffle_url,
        data.poster_id, data.partner_url, data.extra_info, data.notes,
        data.is_commercial, data.is_visible, data.sort_order
    )
    await _save_topics(cse["id"], topics_list, db)
    # Возвращаем с данными из глобальной базы
    row = await db.fetchrow(
        """SELECT cse.*, sp.name, sp.title, sp.achievements,
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM event_collaborators cse JOIN collaborators sp ON sp.id = cse.speaker_id
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
    client_id = int(client["sub"])
    name = (data.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Имя обязательно")

    contact_id: Optional[int] = data.existing_contact_id

    # Если клиент сразу указал existing_contact_id — проверяем что он его
    if contact_id is not None:
        own = await db.fetchval(
            "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2 AND merged_into IS NULL",
            contact_id, client_id
        )
        if not own:
            raise HTTPException(status_code=400, detail="Контакт не найден или принадлежит другому клиенту")
    else:
        # При создании нового контакта обязательна минимум одна личная идентичность —
        # иначе мы не сможем отправить спикеру invite-сообщение для самообслуживания.
        has_personal = any([
            (data.personal_tg_id or "").strip(),
            (data.personal_tg_username or "").strip(),
            (data.personal_vk_id or "").strip(),
            (data.personal_vk_username or "").strip(),
            (data.personal_max_id or "").strip(),
            (data.personal_max_username or "").strip(),
        ])
        if not has_personal:
            raise HTTPException(
                status_code=422,
                detail="Укажите хотя бы один личный аккаунт спикера: Telegram, VK или MAX. Без этого ему не получится отправить инструкцию для редактирования профиля."
            )

    # Если existing_contact_id не дали и не force_create — ищем похожие по имени.
    # Возвращаем клиенту выбор (UI: «Использовать существующего» / «Создать нового»).
    if contact_id is None and not data.force_create:
        matches = await db.fetch(
            """SELECT c.id, c.name, c.email, c.phone,
                      EXISTS(SELECT 1 FROM collaborators col WHERE col.contact_id = c.id) AS has_collab
                 FROM contacts c
                WHERE c.client_id = $1
                  AND c.merged_into IS NULL
                  AND LOWER(TRIM(c.name)) = LOWER($2)
                ORDER BY c.id
                LIMIT 10""",
            client_id, name
        )
        if matches:
            return {
                "needs_choice": True,
                "matches": [
                    {"id": m["id"], "name": m["name"], "email": m["email"],
                     "phone": m["phone"], "has_collab": m["has_collab"]}
                    for m in matches
                ],
            }

    async with db.transaction():
        # 1. Контакт: либо существующий, либо новый
        if contact_id is None:
            contact_id = await db.fetchval(
                """INSERT INTO contacts (client_id, name, ref_code)
                   VALUES ($1, $2, SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8))
                   RETURNING id""",
                client_id, name
            )
        else:
            # Если уже есть коллаб у этого контакта — 409 (один коллаб на контакт)
            existing_coll = await db.fetchval(
                "SELECT id FROM collaborators WHERE contact_id = $1", contact_id
            )
            if existing_coll:
                raise HTTPException(
                    status_code=409,
                    detail=f"У этого контакта уже есть коллаборатор (id={existing_coll}). Откройте его карточку и добавьте в событие через «Из базы»."
                )

        # 2. Коллаб в глобальной базе
        sp = await db.fetchrow(
            """INSERT INTO collaborators
               (contact_id, name, title, achievements,
                photo_url, photo_folder_url, video_folder_url,
                tg_channel_url, vk_url, max_url, instagram_url, website_url, created_by_client_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *""",
            contact_id, name, data.title, data.achievements,
            data.photo_url, data.photo_folder_url, data.video_folder_url,
            data.tg_channel_url, data.vk_url, data.max_url, data.instagram_url, data.website_url,
            client_id
        )
        # Личные идентичности — пишем в platform_users (миграции 107/108).
        from app.api.collaborators import _upsert_personal_identities
        await _upsert_personal_identities(db, client_id, contact_id, data)

        # 3. Участие в событии
        topics_list = data.topics if data.topics is not None else (
            [data.speaker_topic] if data.speaker_topic else []
        )
        first_topic = topics_list[0] if topics_list else None

        cse = await db.fetchrow(
            """INSERT INTO event_collaborators
               (speaker_id, event_id, role, speaker_topic, gift_after_speech_title, gift_after_speech_url,
                gift_raffle_title, gift_raffle_url,
                partner_url, extra_info, notes, is_commercial, is_visible, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *""",
            sp["id"], event_id, data.role, first_topic,
            data.gift_after_speech_title, data.gift_after_speech_url,
            data.gift_raffle_title, data.gift_raffle_url,
            data.partner_url, data.extra_info, data.notes,
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
    # Валидация poster_id и announcement_poster_ids: все должны принадлежать
    # библиотеке этого коллаба (миграции 121-122).
    if raw.get("poster_id") is not None or raw.get("announcement_poster_ids") is not None:
        sp_id = await db.fetchval(
            "SELECT speaker_id FROM event_collaborators WHERE id=$1 AND event_id=$2",
            speaker_event_id, event_id,
        )
        if not sp_id:
            raise HTTPException(status_code=404, detail="Спикер не найден в событии")
        check_ids = []
        if raw.get("poster_id") is not None:
            check_ids.append(int(raw["poster_id"]))
        if raw.get("announcement_poster_ids") is not None:
            check_ids.extend(int(x) for x in raw["announcement_poster_ids"])
        if check_ids:
            valid_count = await db.fetchval(
                "SELECT COUNT(*) FROM collaborator_posters WHERE id = ANY($1::int[]) AND collaborator_id = $2",
                list(set(check_ids)), sp_id,
            )
            if valid_count != len(set(check_ids)):
                raise HTTPException(
                    status_code=400,
                    detail="poster_id / announcement_poster_ids ссылаются на афиши не из библиотеки этого коллаба"
                )
    updates = {k: v for k, v in raw.items() if v is not None}
    if updates:
        set_parts = [f"{k} = ${i+3}" for i, k in enumerate(updates.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2",
            speaker_event_id, event_id, *updates.values()
        )
    if topics_list is not None:
        await _save_topics(speaker_event_id, topics_list, db)
        first_topic = topics_list[0] if topics_list else None
        await db.execute(
            "UPDATE event_collaborators SET speaker_topic=$1 WHERE id=$2",
            first_topic, speaker_event_id
        )
    row = await db.fetchrow(
        """SELECT cse.*, sp.name, sp.title, sp.achievements,
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url
           FROM event_collaborators cse JOIN collaborators sp ON sp.id = cse.speaker_id
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


@router.post("/speakers/{speaker_event_id}/verify-channel", summary="Проверить, что бот видит подписку самого спикера на его канал")
async def verify_speaker_channel(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Проверка идёт по personal_tg_id самого спикера — он гарантированно подписан
    на свой канал. Если бот добавлен в админы канала и видит подписчиков —
    getChatMember вернёт статус creator/administrator/member. Если нет — ошибка
    Telegram расскажет почему (бот не в канале, нет прав, и т.п.).
    """
    client_id = int(client["sub"])
    await check_conference_access(event_id, client_id, db)

    from app.config import settings
    from app.services.channels import get_client_telegram_token
    token = (await get_client_telegram_token(client_id, db)) or settings.telegram_bot_token
    if not token:
        raise HTTPException(status_code=400, detail="Не настроен главный бот клиента — подключите его в разделе «Каналы»")

    # Получаем username бота для понятных сообщений об ошибках
    bot_handle = ""
    try:
        async with httpx.AsyncClient(timeout=5) as http:
            br = await http.get(f"https://api.telegram.org/bot{token}/getMe")
        bot_handle = ((br.json() or {}).get("result") or {}).get("username", "") or ""
    except Exception:
        pass
    bot_ref = f"@{bot_handle}" if bot_handle else "главный бот"

    row = await db.fetchrow(
        """SELECT c.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  c.name
           FROM event_collaborators cse
           JOIN collaborators c ON c.id = cse.speaker_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.id = $1 AND cse.event_id = $2""",
        speaker_event_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    channel_id = (row["tg_channel_id"] or "").strip()
    if not channel_id:
        raise HTTPException(status_code=400, detail="Сначала укажите ID канала спикера и сохраните профиль")

    speaker_tg_id = row["personal_tg_id"]
    if not speaker_tg_id:
        raise HTTPException(
            status_code=400,
            detail="Заполните «ID личного аккаунта» спикера и сохраните — без него не получится проверить канал автоматически"
        )

    try:
        async with httpx.AsyncClient(timeout=8) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/getChatMember",
                params={"chat_id": channel_id, "user_id": speaker_tg_id}
            )
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Ошибка Telegram API: {e}")

    if not data.get("ok"):
        desc = (data.get("description") or "").lower()
        if "member list is inaccessible" in desc:
            detail = f"Бот не админ канала. Добавьте {bot_ref} в администраторы канала спикера (без прав публикации — достаточно нулевых прав)."
        elif "chat not found" in desc:
            if not channel_id.startswith("-100"):
                detail = f"Канал не найден. ID канала должен начинаться с «-100» (у вас: «{channel_id}»). Скопируйте правильный ID и сохраните профиль."
            else:
                detail = f"Канал не найден. Скорее всего {bot_ref} ещё не добавлен в канал. Откройте канал спикера → Управление → Администраторы → добавьте {bot_ref}, и нажмите ещё раз."
        elif "user not found" in desc:
            detail = "Личный аккаунт спикера не найден в Telegram. Проверьте «ID личного аккаунта»."
        elif "bot was kicked" in desc or "kicked" in desc:
            detail = f"Бот удалён из канала. Добавьте {bot_ref} обратно в администраторы."
        elif "not enough rights" in desc or "no rights" in desc:
            detail = f"У бота нет прав видеть подписчиков. Добавьте {bot_ref} как администратора."
        elif "forbidden" in desc:
            detail = f"Нет доступа к каналу. Убедитесь, что {bot_ref} добавлен в администраторы канала."
        else:
            detail = f"Не удалось проверить канал. Telegram ответил: {data.get('description') or 'неизвестная ошибка'}"
        raise HTTPException(status_code=400, detail=detail)

    status = (data.get("result") or {}).get("status", "")
    if status not in ("member", "administrator", "creator", "restricted"):
        # Спикер не подписан на собственный канал? Странно, но возможно — сами выгнали себя.
        speaker_name = row["name"] or "Спикер"
        raise HTTPException(
            status_code=400,
            detail=f"Бот видит канал, но {speaker_name} НЕ подписан(а) на свой канал (статус: {status or 'нет данных'}). Подпишитесь и попробуйте снова."
        )

    await db.execute(
        "UPDATE event_collaborators SET bot_in_channel = TRUE WHERE id = $1",
        speaker_event_id
    )
    speaker_name = row["name"] or "спикер"
    return {"ok": True, "message": f"Бот видит подписку — {speaker_name} в канале (статус: {status}). Канал добавлен в проверку."}


@router.delete("/speakers/{speaker_event_id}", summary="Убрать спикера из события")
async def remove_speaker_from_event(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    await db.execute(
        "DELETE FROM event_collaborators WHERE id = $1 AND event_id = $2",
        speaker_event_id, event_id
    )
    await regenerate_landing_data(event_id, db)
    return {"message": "Спикер убран из события (остался в базе)"}


# ─── Этапы конференции/турнира ────────────────────────────────────────────────
# Опциональный уровень над днями. Если у события нет ни одного этапа —
# дни лежат «без группировки», UI рендерит плоский список (как раньше).

class StageCreate(BaseModel):
    title: str
    subtitle: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[str] = None  # "YYYY-MM-DD"
    end_date: Optional[str] = None
    sort_order: int = 0


class StageUpdate(BaseModel):
    title: Optional[str] = None
    subtitle: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    sort_order: Optional[int] = None


def _parse_date(s: Optional[str]):
    return date.fromisoformat(s) if s else None


@router.get("/stages", summary="Этапы события")
async def list_stages(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    stages = await db.fetch(
        "SELECT * FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id",
        event_id,
    )
    return {"stages": [dict(s) for s in stages]}


@router.post("/stages", summary="Создать этап")
async def create_stage(
    event_id: int,
    data: StageCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    if not data.title.strip():
        raise HTTPException(status_code=422, detail="Название этапа обязательно")
    stage = await db.fetchrow(
        """INSERT INTO conf_stages (event_id, sort_order, title, subtitle, description, start_date, end_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
        event_id, data.sort_order, data.title.strip(),
        data.subtitle, data.description,
        _parse_date(data.start_date), _parse_date(data.end_date),
    )
    return {"stage": dict(stage)}


@router.patch("/stages/{stage_id}", summary="Обновить этап")
async def update_stage(
    event_id: int,
    stage_id: int,
    data: StageUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    payload = data.model_dump(exclude_unset=True)
    if "start_date" in payload:
        payload["start_date"] = _parse_date(payload["start_date"])
    if "end_date" in payload:
        payload["end_date"] = _parse_date(payload["end_date"])
    if "title" in payload and (not payload["title"] or not payload["title"].strip()):
        raise HTTPException(status_code=422, detail="Название этапа обязательно")
    if not payload:
        row = await db.fetchrow("SELECT * FROM conf_stages WHERE id=$1 AND event_id=$2", stage_id, event_id)
        if not row:
            raise HTTPException(status_code=404, detail="Этап не найден")
        return {"stage": dict(row)}
    set_parts = [f"{k} = ${i+3}" for i, k in enumerate(payload.keys())]
    row = await db.fetchrow(
        f"UPDATE conf_stages SET {', '.join(set_parts)} WHERE id=$1 AND event_id=$2 RETURNING *",
        stage_id, event_id, *payload.values()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Этап не найден")
    return {"stage": dict(row)}


@router.delete("/stages/{stage_id}", summary="Удалить этап")
async def delete_stage(
    event_id: int,
    stage_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    # ON DELETE SET NULL на conf_days.stage_id — дни не теряются, просто становятся «вне этапа»
    res = await db.execute("DELETE FROM conf_stages WHERE id=$1 AND event_id=$2", stage_id, event_id)
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="Этап не найден")
    return {"ok": True}


# ─── Программа целиком (для Mini App) ─────────────────────────────────────────

@router.get("/program-public", summary="Программа этапов/дней/сессий для Mini App")
async def get_program_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Возвращает структурированную программу события: этапы → дни → сессии.
    Если этапов нет — массив пустой; фронт рисует плоский список дней.
    stream_url у дней и сессий не возвращаем (отдельный приватный запрос для зарегистрированных).
    """
    stages = await db.fetch(
        "SELECT id, sort_order, title, subtitle, description, start_date, end_date "
        "FROM conf_stages WHERE event_id = $1 ORDER BY sort_order, id",
        event_id,
    )
    days = await db.fetch(
        "SELECT id, day_number, day_date, open_time, close_time, stage_id, title "
        "FROM conf_days WHERE event_id = $1 ORDER BY day_number",
        event_id,
    )
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.start_time, s.end_time, s.title, s.gift_description,
                  s.track_label, s.track_color, s.track_id, s.sort_order,
                  s.speaker_id AS speaker_event_id,
                  col.name AS speaker_name, col.title AS speaker_title,
                  col.photo_url, cse.role AS speaker_role
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, s.sort_order, s.start_time""",
        event_id,
    )
    return {
        "stages":   [dict(s) for s in stages],
        "days":     [dict(d) for d in days],
        "sessions": [dict(s) for s in sessions],
    }


# ─── Дни конференции ──────────────────────────────────────────────────────────

class DayUpdate(BaseModel):
    day_date: Optional[str] = None
    open_time: Optional[str] = None
    close_time: Optional[str] = None
    stream_url: Optional[str] = None
    stage_id: Optional[int] = None  # NULL = день вне этапа
    title: Optional[str] = None     # кастомное имя дня (fallback "День N")


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


@router.get("/days/public", summary="Дни конференции (для Mini App)")
async def list_days_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный список дней без stream_url (его видят только зарегистрированные —
    отдельный запрос). Нужен, чтобы Mini App мог отрисовать аккордеон с днями.
    """
    days = await db.fetch(
        """SELECT day_number, day_date, open_time, close_time, stage_id, title
             FROM conf_days
            WHERE event_id = $1
         ORDER BY day_number""",
        event_id,
    )
    return {"days": [dict(d) for d in days]}


@router.get("/stages/public", summary="Этапы (для Mini App)")
async def list_stages_public(event_id: int, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный список этапов для рендера в Mini App. Группировка дней под этапами —
    клиентская: фронт читает day.stage_id и сопоставляет.
    """
    stages = await db.fetch(
        """SELECT id, sort_order, title, subtitle, description, start_date, end_date
             FROM conf_stages
            WHERE event_id = $1
         ORDER BY sort_order, id""",
        event_id,
    )
    return {"stages": [dict(s) for s in stages]}


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
    # open_time / close_time теперь — простые строки "HH:MM" (МСК по соглашению).
    open_time = _normalize_hhmm(data.open_time)
    close_time = _normalize_hhmm(data.close_time)

    day = await db.fetchrow(
        """INSERT INTO conf_days (event_id, day_number, day_date, open_time, close_time, stream_url, stage_id, title)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (event_id, day_number) DO UPDATE
             SET day_date=$3, open_time=$4, close_time=$5, stream_url=$6, stage_id=$7, title=$8
           RETURNING *""",
        event_id, day_number, day_date, open_time, close_time, data.stream_url, data.stage_id, data.title
    )
    await regenerate_landing_data(event_id, db)
    return {"day": dict(day)}


@router.delete("/days/{day_number}", summary="Удалить день")
async def delete_day(
    event_id: int,
    day_number: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    await check_conference_access(event_id, int(client["sub"]), db)
    # Сначала каскадно удаляем сессии этого дня (на conf_sessions.day нет FK,
    # только колонка INT, поэтому удаляем вручную).
    await db.execute("DELETE FROM conf_sessions WHERE event_id=$1 AND day=$2", event_id, day_number)
    res = await db.execute("DELETE FROM conf_days WHERE event_id=$1 AND day_number=$2", event_id, day_number)
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="День не найден")
    await regenerate_landing_data(event_id, db)
    return {"ok": True}


# ─── Сессии ───────────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    speaker_id: Optional[int] = None
    topic_id: Optional[int] = None
    day: int
    start_time: Optional[str] = None  # "HH:MM" — МСК
    end_time:   Optional[str] = None  # "HH:MM" — МСК
    title: Optional[str] = None  # если не передан — берётся из topic_id
    gift_description: Optional[str] = None
    stream_url: Optional[str] = None
    track_label: Optional[str] = None
    track_color: Optional[str] = None
    track_id: Optional[int] = None  # FK на conf_tracks (на будущее, UI пока не использует)
    sort_order: int = 0


class SessionUpdate(BaseModel):
    speaker_id: Optional[int] = None
    topic_id: Optional[int] = None
    day: Optional[int] = None
    start_time: Optional[str] = None
    end_time:   Optional[str] = None
    title: Optional[str] = None
    gift_description: Optional[str] = None
    stream_url: Optional[str] = None
    track_id: Optional[int] = None
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
                  col.photo_url,
                  pu_tg.username AS personal_tg_username,
                  cse.role as speaker_role, cse.is_commercial,
                  cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.exclude_gift_from_broadcast
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = col.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE s.event_id = $1
           ORDER BY s.day, s.sort_order, s.start_time""",
        event_id
    )
    return {"sessions": [dict(s) for s in sessions]}



@router.get("/sessions/day/{day}", summary="Сессии по дню (для Mini App)")
async def get_sessions_by_day(event_id: int, day: int, db: asyncpg.Connection = Depends(get_db)):
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.start_time, s.end_time, s.title,
                  s.gift_description, s.stream_url, s.track_label, s.track_color, s.track_id,
                  s.speaker_id AS speaker_event_id,
                  col.name as speaker_name, col.title as speaker_title,
                  col.photo_url, cse.role as speaker_role,
                  cse.gift_after_speech_title, cse.gift_after_speech_url
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators col ON col.id = cse.speaker_id
           WHERE s.event_id = $1 AND s.day = $2
           ORDER BY s.sort_order, s.start_time""",
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
    start_t = _normalize_hhmm(data.start_time)
    end_t   = _normalize_hhmm(data.end_time)

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
          (event_id, speaker_id, topic_id, day, start_time, end_time, title,
           gift_description, stream_url, track_label, track_color, track_id, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *""",
        event_id, data.speaker_id, data.topic_id, data.day, start_t, end_t, title,
        data.gift_description, data.stream_url, data.track_label, data.track_color, data.track_id, data.sort_order
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
            if k in ("start_time", "end_time"):
                updates[k] = _normalize_hhmm(v)
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

    # Удаляем старые сессии этого дня
    await db.execute(
        "DELETE FROM conf_sessions WHERE event_id=$1 AND day=$2", event_id, data.day
    )

    # Парсим время начала и шагаем строкой "HH:MM" — без TZ-математики.
    h, m = map(int, _normalize_hhmm(data.start_time).split(":"))
    cursor_min = h * 60 + m  # минут от 00:00 МСК

    def _mm_to_hhmm(mm: int) -> str:
        mm = mm % (24 * 60)
        return f"{mm // 60:02d}:{mm % 60:02d}"

    created = []
    for idx, speaker_event_id in enumerate(data.speaker_ids):
        # speaker_ids теперь — это event_collaborators.id
        cse = await db.fetchrow(
            """SELECT cse.id, sp.name FROM event_collaborators cse
               JOIN collaborators sp ON sp.id = cse.speaker_id
               WHERE cse.id=$1 AND cse.event_id=$2""",
            speaker_event_id, event_id
        )
        if not cse:
            continue
        slot_start = _mm_to_hhmm(cursor_min)
        slot_end = _mm_to_hhmm(cursor_min + data.slot_duration)
        session = await db.fetchrow(
            """INSERT INTO conf_sessions
               (event_id, speaker_id, day, start_time, end_time, title, sort_order)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
            event_id, speaker_event_id, data.day, slot_start, slot_end,
            "Выступление", idx
        )
        created.append(dict(session))
        cursor_min += data.slot_duration + data.break_duration

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
                  s.start_time as session_time
           FROM conf_broadcast_messages b
           LEFT JOIN event_collaborators cse ON cse.id = b.speaker_id
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
        """SELECT s.*, d.day_date,
                  spg.name AS speaker_name, cse.gift_after_speech_title, cse.gift_after_speech_url
           FROM conf_sessions s
           LEFT JOIN conf_days d ON d.event_id = s.event_id AND d.day_number = s.day
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators spg ON spg.id = cse.speaker_id
           WHERE s.event_id = $1 AND s.start_time IS NOT NULL
           ORDER BY s.day, s.start_time""",
        event_id
    )

    created = 0
    for s in sessions:
        if not s["start_time"] or not s["day_date"]:
            continue
        # Собираем UTC момент отправки: МСК (start_time на day_date) минус 3 часа.
        sh, sm = map(int, str(s["start_time"])[:5].split(":"))
        msk_naive_start = datetime.combine(s["day_date"], time(sh, sm))
        utc_start = msk_naive_start - timedelta(hours=3)
        pre5 = utc_start - timedelta(minutes=5)

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
        if s["end_time"] and (s["gift_after_speech_title"] or s.get("gift_description")):
            eh, em = map(int, str(s["end_time"])[:5].split(":"))
            msk_naive_end = datetime.combine(s["day_date"], time(eh, em))
            utc_end = msk_naive_end - timedelta(hours=3)
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
                    event_id, s["id"], s["speaker_id"], utc_end, gift_msg
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
           LEFT JOIN event_collaborators cse ON cse.id = sc.speaker_id
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
    # poster_url убран миграцией 121 — афиши теперь в библиотеке (collaborator_posters).
    photo_folder_url: Optional[str] = None
    video_folder_url: Optional[str] = None
    tg_channel_url: Optional[str] = None
    vk_url: Optional[str] = None
    max_url: Optional[str] = None
    instagram_url: Optional[str] = None
    website_url: Optional[str] = None
    tg_channel_id: Optional[str] = None
    personal_tg_id: Optional[str] = None
    personal_tg_username: Optional[str] = None
    personal_vk_id: Optional[str] = None
    personal_vk_username: Optional[str] = None
    personal_max_id: Optional[str] = None
    personal_max_username: Optional[str] = None
    assistant_tg_username: Optional[str] = None
    # Данные выступления (таблица event_collaborators)
    topics: Optional[List[str]] = None
    gift_after_speech_title: Optional[str] = None
    gift_after_speech_url: Optional[str] = None
    gift_raffle_title: Optional[str] = None
    gift_raffle_url: Optional[str] = None
    keyword_code: Optional[str] = None
    knowledge_base_title: Optional[str] = None
    knowledge_base_url: Optional[str] = None
    # Тогглы видимости полей в self-edit (миграция 108)
    show_topic_field: Optional[bool] = None
    show_gift_after_speech_field: Optional[bool] = None
    show_knowledge_base_field: Optional[bool] = None


@router.get("/speakers/by-code/{ref_code}", summary="Профиль спикера по ref_code (без авторизации)")
async def get_speaker_by_ref_code(event_id: int, ref_code: str, db: asyncpg.Connection = Depends(get_db)):
    """
    Публичный endpoint без авторизации.
    Возвращает полные данные спикера по его персональному ref_code.
    Используется для страницы самопроверки/редактирования спикером.
    """
    # Резолв: ref_code → contacts → collaborators → event_collaborators
    row = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id, cse.event_id, cse.role,
                  cse.speaker_topic, cse.gift_after_speech_title, cse.gift_after_speech_url,
                  cse.gift_raffle_title, cse.gift_raffle_url,
                  cse.is_commercial, c.ref_code, cse.keyword_code,
                  sp.name, sp.title, sp.achievements,
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM contacts c
           JOIN collaborators sp ON sp.contact_id = c.id
           JOIN event_collaborators cse ON cse.speaker_id = sp.id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = c.id AND pu_tg.platform_slug = 'telegram'
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
    Обновляет и профиль (collaborators), и данные выступления (event_collaborators).
    """
    cse = await db.fetchrow(
        """SELECT cse.id, cse.speaker_id
           FROM contacts ct
           JOIN collaborators c ON c.contact_id = ct.id
           JOIN event_collaborators cse ON cse.speaker_id = c.id
           WHERE ct.ref_code = $1 AND cse.event_id = $2""",
        ref_code, event_id
    )
    if not cse:
        raise HTTPException(status_code=404, detail="Ссылка недействительна")

    speaker_event_id = cse["id"]
    speaker_id = cse["speaker_id"]

    # Обновляем глобальный профиль спикера (collaborators).
    # Личный TG (personal_tg_id/username) живёт в platform_users — апсертим отдельно.
    profile_fields = ["name", "title", "achievements", "photo_url",
                      "photo_folder_url", "video_folder_url", "tg_channel_url",
                      "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id",
                      "assistant_tg_username"]
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

    if any(getattr(data, fld, None) is not None for fld in (
        "personal_tg_id", "personal_tg_username",
        "personal_vk_id", "personal_vk_username",
        "personal_max_id", "personal_max_username",
    )):
        from app.api.collaborators import _upsert_personal_identities
        coll_info = await db.fetchrow(
            "SELECT contact_id, created_by_client_id FROM collaborators WHERE id = $1",
            speaker_id
        )
        if coll_info and coll_info["contact_id"]:
            await _upsert_personal_identities(
                db, coll_info["created_by_client_id"], coll_info["contact_id"], data
            )

    # Обновляем данные выступления (event_collaborators)
    event_updates: dict = {}
    for f in ("gift_after_speech_title", "gift_after_speech_url",
              "gift_raffle_title", "gift_raffle_url",
              "knowledge_base_title", "knowledge_base_url",
              "show_topic_field", "show_gift_after_speech_field",
              "show_knowledge_base_field"):
        v = getattr(data, f, None)
        if v is not None:
            event_updates[f] = v

    if event_updates:
        set_parts2 = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(set_parts2)} WHERE id = $1",
            speaker_event_id, *event_updates.values()
        )

    # Темы выступления
    if data.topics is not None:
        await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id = $1", speaker_event_id)
        topics = [t.strip() for t in data.topics if t.strip()]
        if topics:
            first_topic = topics[0]
            await db.execute(
                "UPDATE event_collaborators SET speaker_topic = $1 WHERE id = $2",
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
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
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
        "SELECT id, speaker_id FROM event_collaborators WHERE id = $1 AND event_id = $2",
        speaker_event_id, event_id
    )
    if not cse:
        raise HTTPException(status_code=404, detail="Спикер не найден")

    speaker_id = cse["speaker_id"]

    # Профиль (без personal_tg_* — они живут в platform_users, миграция 107)
    profile_fields = ["name", "title", "achievements", "photo_url",
                      "photo_folder_url", "video_folder_url", "tg_channel_url",
                      "vk_url", "max_url",
                      "instagram_url", "website_url", "tg_channel_id",
                      "assistant_tg_username"]
    profile_updates = {k: getattr(data, k) for k in profile_fields if getattr(data, k) is not None}
    if profile_updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(profile_updates.keys())]
        set_parts.append("updated_at = NOW()")
        await db.execute(
            f"UPDATE collaborators SET {', '.join(set_parts)} WHERE id = $1",
            speaker_id, *profile_updates.values()
        )

    if any(getattr(data, fld, None) is not None for fld in (
        "personal_tg_id", "personal_tg_username",
        "personal_vk_id", "personal_vk_username",
        "personal_max_id", "personal_max_username",
    )):
        from app.api.collaborators import _upsert_personal_identities
        coll_info = await db.fetchrow(
            "SELECT contact_id, created_by_client_id FROM collaborators WHERE id = $1",
            speaker_id
        )
        if coll_info and coll_info["contact_id"]:
            await _upsert_personal_identities(
                db, coll_info["created_by_client_id"], coll_info["contact_id"], data
            )

    # Выступление
    event_updates: dict = {}
    for k in ["gift_after_speech_title", "gift_after_speech_url",
              "gift_raffle_title", "gift_raffle_url",
              "keyword_code",
              "knowledge_base_title", "knowledge_base_url",
              "show_topic_field", "show_gift_after_speech_field",
              "show_knowledge_base_field"]:
        v = getattr(data, k, None)
        if v is not None:
            event_updates[k] = v
    if event_updates:
        set_parts2 = [f"{k} = ${i+2}" for i, k in enumerate(event_updates.keys())]
        await db.execute(
            f"UPDATE event_collaborators SET {', '.join(set_parts2)} WHERE id = $1",
            speaker_event_id, *event_updates.values()
        )

    # Темы
    if data.topics is not None:
        await db.execute("DELETE FROM conf_speaker_topics WHERE cse_id = $1", speaker_event_id)
        clean_topics = [t.strip() for t in data.topics if t.strip()]
        if clean_topics:
            await db.execute(
                "UPDATE event_collaborators SET speaker_topic = $1 WHERE id = $2",
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
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.photo_folder_url, sp.video_folder_url,
                  sp.tg_channel_url, sp.instagram_url, sp.website_url,
                  sp.tg_channel_id,
                  pu_tg.platform_user_id AS personal_tg_id,
                  pu_tg.username         AS personal_tg_username,
                  sp.assistant_tg_username
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = sp.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
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

    # Спикеры
    rows = await db.fetch(
        """SELECT cse.id, cse.speaker_id, cse.role,
                  cse.gift_after_speech_title, cse.gift_raffle_title,
                  cse.sort_order, cse.is_visible,
                  sp.name, sp.title, sp.achievements,
                  sp.tg_channel_url, sp.tg_channel_id, sp.instagram_url
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
           ORDER BY cse.sort_order, cse.id""",
        event_id
    )
    topics_map = await _load_topics([r["id"] for r in rows], db)

    # Дни + сессии: время хранится строкой "HH:MM" (МСК), показываем как есть.
    days = await db.fetch(
        "SELECT * FROM conf_days WHERE event_id = $1 ORDER BY day_number", event_id
    )
    sessions = await db.fetch(
        """SELECT s.id, s.day, s.sort_order, s.title,
                  s.start_time AS start_local,
                  s.end_time   AS end_local,
                  sp.name AS speaker_name, cse.role AS speaker_role
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, s.sort_order, s.start_time""",
        event_id
    )

    speakers_list = [dict(r) for r in rows]

    def fmt_time(val):
        if val is None or val == "":
            return ""
        return str(val)[:5]

    def fmt_date(val):
        if val is None:
            return ""
        months = ["января","февраля","марта","апреля","мая","июня",
                  "июля","августа","сентября","октября","ноября","декабря"]
        if hasattr(val, "day"):
            return f"{val.day} {months[val.month - 1]}"
        return str(val)

    # Разбиваем спикеров на группы для каналов.
    # Организатор определяется ролью спикера (cse.role == 'organizer'),
    # а не отдельным полем conf_conferences.organizer_speaker_id (удалено).
    def split_by_role(sp_list, role_key="role"):
        organizers = [s for s in sp_list if s.get("role") == "organizer"]
        organizer_ids = {s["id"] for s in organizers}
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
            role_label = {"headliner": "хедлайнер", "organizer": "организатор", "jury": "жюри"}.get(sp_role, "")
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
                  cp_cse.url AS cse_poster_url,
                  sp.name, sp.achievements,
                  sp.photo_url,
                  (SELECT url FROM collaborator_posters cp_g
                     WHERE cp_g.collaborator_id = sp.id
                     ORDER BY cp_g.sort_order, cp_g.id
                     LIMIT 1) AS poster_url,
                  sp.tg_channel_url, sp.instagram_url
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN collaborator_posters cp_cse ON cp_cse.id = cse.poster_id
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

SCHEDULE_ROLES_WITH_LABEL = {"headliner", "organizer", "jury", "partner", "general_partner"}

ROLE_LABELS_RU = {
    "headliner": "хедлайнер",
    "organizer": "организатор",
    "jury": "жюри",
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

def _fmt_time(val) -> str:
    # Время в БД теперь хранится строкой "HH:MM" — отдаём как есть, без TZ-математики.
    if val is None or val == "":
        return "?"
    return str(val)[:5]

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
            line = f"<b>{time_start} - {time_end} МСК</b>: {title}"
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

    # Данные конференции (для ссылки). Лендинг = events.landing_url
    # (после миграции 057), fallback на legacy getcourse_form_url.
    conf = await db.fetchrow(
        """SELECT e.landing_url, cc.getcourse_form_url
             FROM events e
             LEFT JOIN conf_conferences cc ON cc.event_id = e.id
            WHERE e.id = $1""",
        event_id
    )
    conf_url = ""
    if conf:
        conf_url = (conf["landing_url"] or conf["getcourse_form_url"] or "").strip()

    # Дни конференции
    days_db = await db.fetch(
        "SELECT day_number, day_date FROM conf_days WHERE event_id = $1 ORDER BY day_number",
        event_id
    )

    # Сессии с ролью
    sessions_db = await db.fetch(
        """SELECT s.day, s.start_time, s.end_time, s.title, s.sort_order,
                  sp.name AS speaker_name, cse.role
           FROM conf_sessions s
           LEFT JOIN event_collaborators cse ON cse.id = s.speaker_id
           LEFT JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE s.event_id = $1
           ORDER BY s.day, s.sort_order, s.start_time""",
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
                    "time_start": _fmt_time(s["start_time"]),
                    "time_end": _fmt_time(s["end_time"]),
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

RAFFLE_ROLES_WITH_LABEL = {"headliner", "organizer", "jury", "partner", "general_partner"}

RAFFLE_ROLE_LABELS_RU = {
    "headliner": "хедлайнер",
    "organizer": "организатор",
    "jury": "жюри",
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
           FROM event_collaborators cse
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
        "SELECT id, client_id FROM events WHERE id = $1 AND module_slug IN ('conference','turnir')", event_id
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
                  col.name,
                  pu_tg.username AS username,
                  COUNT(ep.id) FILTER (WHERE ep.id IS NOT NULL) AS entered,
                  COUNT(ep.id) FILTER (WHERE ep.is_registered = TRUE) AS registered
           FROM event_collaborators cse
           JOIN collaborators col ON col.id = cse.speaker_id
           LEFT JOIN contacts c ON c.id = col.contact_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = col.contact_id AND pu_tg.platform_slug = 'telegram'
           LEFT JOIN event_participants ep ON ep.event_id = $1
               AND ep.referrer_ref_code = c.ref_code
           WHERE cse.event_id = $1
           GROUP BY cse.id, cse.speaker_id, c.ref_code, cse.role,
                    cse.is_commercial, cse.sort_order, col.name, pu_tg.username
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
    # Исключаем спикеров через JOIN: спикер — это коллаб со связкой на contact, и есть запись в event_collaborators
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
                 JOIN event_collaborators cse ON cse.speaker_id = c.id
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
                 JOIN event_collaborators cse ON cse.speaker_id = c.id
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


@router.get("/speakers/{speaker_event_id}/click-stats",
            summary="Статистика кликов по карточке спикера в Mini App (миграция 109)")
async def speaker_click_stats(
    event_id: int,
    speaker_event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Возвращает счётчики кликов по платформам + список контактов, кто кликнул."""
    await check_conference_access(event_id, int(client["sub"]), db)
    counts = await db.fetch(
        """SELECT click_kind, COUNT(*) AS cnt
             FROM event_collaborator_clicks
            WHERE event_collaborator_id = $1
            GROUP BY click_kind""",
        speaker_event_id,
    )
    by_kind = {r["click_kind"]: int(r["cnt"]) for r in counts}
    recent = await db.fetch(
        """SELECT c.id, c.name, c.email, c.phone, cl.click_kind, cl.clicked_at,
                  cl.contact_name AS snapshot_name,
                  cl.tg_id        AS snapshot_tg_id,
                  cl.tg_nickname  AS snapshot_tg_nickname,
                  cl.vk_id        AS snapshot_vk_id,
                  cl.max_id       AS snapshot_max_id,
                  -- COALESCE: используем актуальные данные контакта (если жив),
                  -- иначе fallback на снапшот при клике (миграция 110).
                  COALESCE(c.name, cl.contact_name) AS display_name,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS contact_tg_id,
                  (SELECT pu.username        FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1) AS contact_tg_nickname,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1) AS contact_vk_id,
                  (SELECT pu.platform_user_id FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1) AS contact_max_id
             FROM event_collaborator_clicks cl
             LEFT JOIN contacts c ON c.id = cl.contact_id
            WHERE cl.event_collaborator_id = $1
            ORDER BY cl.clicked_at DESC
            LIMIT 200""",
        speaker_event_id,
    )
    # Финальные поля для фронта: эффективные tg_id/vk_id/max_id (актуальные → снапшот)
    out_recent = []
    for r in recent:
        d = dict(r)
        d["tg_id"]       = d.pop("contact_tg_id")       or d.pop("snapshot_tg_id")
        d["tg_nickname"] = d.pop("contact_tg_nickname") or d.pop("snapshot_tg_nickname")
        d["vk_id"]       = d.pop("contact_vk_id")       or d.pop("snapshot_vk_id")
        d["max_id"]      = d.pop("contact_max_id")      or d.pop("snapshot_max_id")
        d["name"]        = d.pop("display_name") or d.get("name")
        d.pop("snapshot_name", None)
        out_recent.append(d)
    return {
        "by_kind": by_kind,
        "total": sum(by_kind.values()),
        "recent": out_recent,
    }


@router.get("/click-report",
            summary="Сводный отчёт кликов по всем спикерам конференции")
async def conference_click_report(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Для отдельной подвкладки в Отчёте: имя спикера + counts по платформам."""
    await check_conference_access(event_id, int(client["sub"]), db)
    rows = await db.fetch(
        """SELECT cse.id AS ec_id, cse.role, c.name AS speaker_name,
                  SUM(CASE WHEN cl.click_kind = 'tg_channel'     THEN 1 ELSE 0 END) AS tg_channel,
                  SUM(CASE WHEN cl.click_kind = 'vk'             THEN 1 ELSE 0 END) AS vk,
                  SUM(CASE WHEN cl.click_kind = 'max'            THEN 1 ELSE 0 END) AS max_clicks,
                  SUM(CASE WHEN cl.click_kind = 'instagram'      THEN 1 ELSE 0 END) AS instagram,
                  SUM(CASE WHEN cl.click_kind = 'website'        THEN 1 ELSE 0 END) AS website,
                  SUM(CASE WHEN cl.click_kind = 'knowledge_base' THEN 1 ELSE 0 END) AS knowledge_base
             FROM event_collaborators cse
             JOIN collaborators c ON c.id = cse.speaker_id
             LEFT JOIN event_collaborator_clicks cl ON cl.event_collaborator_id = cse.id
            WHERE cse.event_id = $1
            GROUP BY cse.id, cse.role, c.name, cse.sort_order
            ORDER BY cse.sort_order, c.name""",
        event_id,
    )
    return {"rows": [dict(r) for r in rows]}

