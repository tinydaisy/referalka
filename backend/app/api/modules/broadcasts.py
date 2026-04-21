from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta
import asyncpg
import re

RU_MONTHS = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля",
    5: "мая", 6: "июня", 7: "июля", 8: "августа",
    9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
}

def ru_date(d) -> str:
    return f"{d.day} {RU_MONTHS[d.month]}"
from zoneinfo import ZoneInfo

from app.database import get_db
from app.auth import get_current_client

router = APIRouter(prefix="/events/{event_id}/broadcasts", tags=["Рассылки"])

ROLE_LABELS_INTRO = {"speaker": "Спикер", "headliner": "Хедлайнер", "partner": "Партнёр", "organizer": "Организатор"}

def build_speaker_intro_message(tmpl_text, speaker_name, personal_tg, tg_channel_url, instagram_url,
                                achievements, role, speaker_topic, gift_title, gift_raffle, registration_url):
    text = tmpl_text or ""
    role_label = ROLE_LABELS_INTRO.get(role or "", "Спикер")
    tg_ch = (tg_channel_url or "").strip()
    insta = (instagram_url or "").strip()
    ach_list = [a.strip() for a in (achievements or []) if a.strip()]
    topic = (speaker_topic or "").strip()
    gift_title_v = (gift_title or "").strip()
    gift_raffle_v = (gift_raffle or "").strip()

    ach_text = "\n".join(f"• {a}" for a in ach_list)

    # Сначала убираем строки с пустыми плейсхолдерами (пока они ещё в тексте)
    if not topic:
        text = re.sub(r"^[^\n]*\{speaker_topic\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not ach_text:
        text = re.sub(r"^[^\n]*О спикере[^\n]*\n?", "", text, flags=re.MULTILINE)
        text = re.sub(r"^[^\n]*\{speaker_achievements\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not gift_title_v:
        text = re.sub(r"^[^\n]*\{gift_after_speech_title\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not gift_raffle_v:
        text = re.sub(r"^[^\n]*\{gift_raffle_title\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not tg_ch:
        text = re.sub(r"^[^\n]*\{speaker_tg\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not insta:
        text = re.sub(r"^[^\n]*\{speaker_instagram\}[^\n]*\n?", "", text, flags=re.MULTILINE)

    # Потом подставляем значения
    text = text.replace("{speaker_name}", speaker_name or "")
    text = text.replace("{speaker_role}", role_label)
    text = text.replace("{speaker_topic}", topic)
    text = text.replace("{speaker_achievements}", ach_text)
    text = text.replace("{gift_after_speech_title}", gift_title_v)
    text = text.replace("{gift_raffle_title}", gift_raffle_v)
    text = text.replace("{registration_url}", registration_url or "")
    if tg_ch:
        text = text.replace("{speaker_tg}", f"<b>Тг канал:</b> {tg_ch}")
    if insta:
        text = text.replace("{speaker_instagram}", f"<b>Нельзяграм:</b> {insta}")

    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ─────────────────────────────────────────
# ШАБЛОНЫ
# ─────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    type: str
    text: Optional[str] = None
    photo_url: Optional[str] = None
    button_text: Optional[str] = None
    button_url: Optional[str] = None


class TemplateUpdate(BaseModel):
    name: str
    type: str
    text: Optional[str] = None
    photo_url: Optional[str] = None
    button_text: Optional[str] = None
    button_url: Optional[str] = None
    schedule_mode: Optional[str] = None
    offset_minutes: Optional[int] = None
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    allow_custom_datetime: Optional[bool] = None
    intro_start_time: Optional[str] = None      # "11:00" — время старта первого спикера
    intro_interval_min: Optional[int] = None    # интервал между спикерами в минутах
    intro_days_before: Optional[int] = None     # за сколько дней до конференции


DEFAULT_TEMPLATES = [
    {
        "name": "Анонс спикера (за 5 мин до старта)",
        "type": "pre_start",
        "text": (
            "Через 5 минут выступает {speaker_name}\n\n"
            "Тема: «{speaker_topic}»\n\n"
            "Заходи в эфир, получай полезный контент и находи секретный код для розыгрыша!\n"
            "👇👇👇\n"
            "{stream_url}"
        ),
        "photo_url": None,
        "button_text": "Войти в эфир",
        "button_url": "{stream_url}",
        "schedule_mode": "fixed_offset",
        "offset_minutes": 5,
        "audience_include": "all_client",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
    {
        "name": "Подарок спикера (за 5 мин до конца)",
        "type": "gift",
        "text": (
            "🎁 {speaker_name}: Подарки после эфира\n\n"
            "{gift_title}\n"
            "{gift_url}"
        ),
        "photo_url": None,
        "button_text": None,
        "button_url": None,
        "schedule_mode": "fixed_offset",
        "offset_minutes": 5,
        "audience_include": "all_event",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
    {
        "name": "Знакомство со спикером",
        "type": "speaker_intro",
        "text": (
            "<b>{speaker_name} — {speaker_role}</b>\n\n"
            "{speaker_tg}\n"
            "{speaker_instagram}\n\n"
            "<b>Тема:</b> {speaker_topic}\n\n"
            "<b>О спикере:</b>\n"
            "{speaker_achievements}\n\n"
            "🎁 <b>На эфире подарит:</b> {gift_after_speech_title}\n\n"
            "🏆 <b>Подарок для большого розыгрыша:</b> {gift_raffle_title}\n\n"
            "<b>Если вы ещё не зарегистрированы — вы ещё успеваете это сделать</b>\n"
            "🔗 {registration_url} \n\n"
            "<b>Жмите на кнопку</b>"
        ),
        "photo_url": None,
        "button_text": "Зарегистрироваться",
        "button_url": "{registration_url}",
        "schedule_mode": "custom_datetime",
        "offset_minutes": 0,
        "audience_include": "all_client",
        "audience_exclude": "none",
        "allow_custom_datetime": True,
    },
    {
        "name": "День конференции — за 30 мин (не зарегистрирован)",
        "type": "day_start_30min_unreg",
        "text": (
            "<b>[Последний шанс зарегистрироваться] Через 30 минут стартует День {day_number} конференции «{conf_title}»</b>\n\n"
            "🔗 {registration_url} \n\n"
            "Сегодня в программе:\n\n"
            "{day_date}\n\n"
            "{day_program}\n\n"
            "Нажимай на кнопку «Зарегистрироваться», чтобы попасть в вебинарную комнату.\n"
            "🔗 {registration_url}\n\n"
            "—\n"
            "При возникновении технических трудностей пишите — @forbs_service2"
        ),
        "photo_url": None,
        "button_text": "Зарегистрироваться",
        "button_url": "{registration_url}",
        "schedule_mode": "day_offset",
        "offset_minutes": 30,
        "audience_include": "all_client",
        "audience_exclude": "registered_event",
        "allow_custom_datetime": False,
    },
    {
        "name": "День конференции — за 30 мин (зарегистрирован)",
        "type": "day_start_30min_reg",
        "text": (
            "<b>[Уже через 30 минут] Стартует День {day_number} конференции «{conf_title}»</b>\n\n"
            "🔗 {stream_url}\n\n"
            "Сегодня в программе:\n\n"
            "{day_date}\n\n"
            "{day_program}\n\n"
            "Нажимай на кнопку «Войти в эфир», чтобы попасть в вебинарную комнату.\n"
            "🔗 {stream_url}\n\n"
            "—\n"
            "При возникновении технических трудностей пишите — @forbs_service2"
        ),
        "photo_url": None,
        "button_text": "Войти в эфир",
        "button_url": "{stream_url}",
        "schedule_mode": "day_offset",
        "offset_minutes": 30,
        "audience_include": "registered_event",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
    {
        "name": "День конференции (старт эфира)",
        "type": "day_live",
        "text": (
            "Мы начинаем День {day_number} масштабной онлайн-конференции «{conf_title}»\n\n"
            "<b>Нажимай на кнопку «Войти в эфир»</b>\n"
            "👇🏻👇🏻👇🏻\n"
            "{stream_url}\n\n"
            "—\n"
            "При возникновении технических трудностей пишите — @forbs_service2"
        ),
        "photo_url": None,
        "button_text": "Войти в эфир",
        "button_url": "{stream_url}",
        "schedule_mode": "day_offset",
        "offset_minutes": 5,
        "audience_include": "all_event",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
    {
        "name": "День конференции (итоги дня + подарки)",
        "type": "day_end",
        "text": (
            "Благодарим вас за участие в {day_ordinal} дне конференции «{conf_title}»\n\n"
            "Самое время ввести собранные КОДОВЫЕ СЛОВА и получить за них дополнительные билеты для розыгрыша:\n"
            "{raffle_url}\n\n"
            "<b>{next_day_mention}</b>\n\n"
            "—\n\n"
            "{day_speakers_gifts}"
        ),
        "photo_url": None,
        "button_text": "ВВЕСТИ КОДОВЫЕ СЛОВА",
        "button_url": "{raffle_url}",
        "schedule_mode": "day_offset",
        "offset_minutes": 30,
        "audience_include": "all_event",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
]


@router.get("/templates", summary="Список шаблонов рассылок")
async def list_templates(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await db.fetch(
        """
        SELECT id, name, type, text, photo_url, button_text, button_url,
               schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before,
               created_at
        FROM broadcast_templates
        WHERE event_id = $1
        ORDER BY type, created_at
        """,
        event_id
    )

    if not rows:
        for tpl in DEFAULT_TEMPLATES:
            await db.execute(
                """
                INSERT INTO broadcast_templates
                  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
                   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                """,
                client_id, event_id, tpl["name"], tpl["type"],
                tpl["text"], tpl["photo_url"], tpl["button_text"], tpl["button_url"],
                tpl["schedule_mode"], tpl["offset_minutes"],
                tpl["audience_include"], tpl["audience_exclude"], tpl["allow_custom_datetime"],
            )
        rows = await db.fetch(
            """
            SELECT id, name, type, text, photo_url, button_text, button_url,
                   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                   created_at
            FROM broadcast_templates
            WHERE event_id = $1
            ORDER BY type, created_at
            """,
            event_id
        )

    conf_row = await db.fetchrow(
        "SELECT poster_horizontal FROM conf_conferences WHERE event_id = $1", event_id
    )
    default_poster = (conf_row["poster_horizontal"][0] if conf_row and conf_row["poster_horizontal"] else None)
    result = []
    for r in rows:
        d = dict(r)
        if d["type"] in ("day_end", "day_live") and not d["photo_url"] and default_poster:
            d["photo_url"] = default_poster
        result.append(d)
    return {"templates": result}


@router.post("/templates", summary="Создать шаблон")
async def create_template(
    event_id: int,
    data: TemplateCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates (client_id, event_id, name, type, text, photo_url, button_text, button_url)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, name, type, text, photo_url, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime, created_at
        """,
        client_id, event_id, data.name, data.type,
        data.text, data.photo_url, data.button_text, data.button_url
    )
    return dict(row)


@router.put("/templates/{template_id}", summary="Редактировать шаблон")
async def update_template(
    event_id: int,
    template_id: int,
    data: TemplateUpdate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    row = await db.fetchrow(
        """
        UPDATE broadcast_templates SET
            name = $1, type = $2, text = $3,
            photo_url = $4, button_text = $5, button_url = $6,
            schedule_mode = COALESCE($7, schedule_mode),
            offset_minutes = COALESCE($8, offset_minutes),
            audience_include = COALESCE($9, audience_include),
            audience_exclude = COALESCE($10, audience_exclude),
            allow_custom_datetime = COALESCE($11, allow_custom_datetime),
            intro_start_time = COALESCE($12, intro_start_time),
            intro_interval_min = COALESCE($13, intro_interval_min),
            intro_days_before = COALESCE($14, intro_days_before),
            updated_at = NOW()
        WHERE id = $15 AND event_id = $16
        RETURNING id, name, type, text, photo_url, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  intro_start_time, intro_interval_min, intro_days_before
        """,
        data.name, data.type, data.text,
        data.photo_url, data.button_text, data.button_url,
        data.schedule_mode, data.offset_minutes,
        data.audience_include, data.audience_exclude, data.allow_custom_datetime,
        data.intro_start_time, data.intro_interval_min, data.intro_days_before,
        template_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    return dict(row)


@router.delete("/templates/{template_id}", summary="Удалить шаблон")
async def delete_template(
    event_id: int,
    template_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    await db.execute(
        "DELETE FROM broadcast_templates WHERE id = $1 AND event_id = $2",
        template_id, event_id
    )
    return {"ok": True}


# ─────────────────────────────────────────
# РАСПИСАНИЕ РАССЫЛОК
# ─────────────────────────────────────────

class ManualScheduleCreate(BaseModel):
    template_id: int
    fire_at: str            # ISO datetime строка, например "2026-04-21T14:30:00"
    is_test: bool = False
    audience_include: Optional[str] = None   # переопределить, если None — берём из шаблона
    audience_exclude: Optional[str] = None


@router.get("/schedules", summary="Очередь рассылок")
async def list_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await db.fetch(
        """
        SELECT bs.id, bs.type, bs.fire_at, bs.status,
               bs.recipients_sent, bs.is_test, bs.audience_include, bs.audience_exclude,
               bt.name as template_name, bt.type as template_type,
               bt.schedule_mode,
               cs.title as session_title,
               cs.start_datetime, cs.end_datetime,
               CASE
                 WHEN bs.type = 'speaker_intro' THEN ci.name
                 ELSE c.name
               END as speaker_name,
               bs.session_id,
               bs.error_log
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        LEFT JOIN conf_sessions cs ON cs.id = bs.session_id AND bs.type != 'speaker_intro'
        LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
        LEFT JOIN collaborators c ON c.id = cse.speaker_id
        LEFT JOIN conf_speaker_events cse_intro ON cse_intro.id = bs.session_id AND bs.type = 'speaker_intro'
        LEFT JOIN collaborators ci ON ci.id = cse_intro.speaker_id
        WHERE bs.event_id = $1
        ORDER BY bs.fire_at NULLS LAST
        """,
        event_id
    )

    # Часовой пояс клиента для отображения
    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
    tz = ZoneInfo(tz_str)

    now_utc = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC"))
    result = []
    for r in rows:
        d = dict(r)
        if r["fire_at"]:
            fire_local = r["fire_at"].astimezone(tz)
            d["fire_at_local"] = fire_local.strftime("%d.%m.%Y %H:%M")
            d["fire_at_tz"] = tz_str
            d["fire_at_iso"] = r["fire_at"].isoformat()
        if r["fire_at"] and r["status"] in ("pending", "draft"):
            diff = (r["fire_at"] - now_utc).total_seconds()
            d["seconds_until"] = max(0, int(diff))
        else:
            d["seconds_until"] = None
        result.append(d)

    # Следующая ожидающая рассылка (pending или draft с временем)
    pending = [x for x in result if x["status"] in ("pending", "draft") and x.get("fire_at_local")]
    next_pending = pending[0] if pending else None

    return {
        "schedules": result,
        "next_pending": next_pending,
        "timezone": tz_str,
    }


@router.post("/schedules/generate", summary="Создать расписание из программы конференции")
async def generate_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Создаёт записи broadcast_schedules:
    - speaker_intro: одна на всё событие, fire_at = NULL (нужна кастомная дата)
    - pre_start: за offset_minutes до start_datetime сессии
    - gift: за offset_minutes до end_datetime сессии
    - day_start_30min_unreg/reg: за offset_minutes до первой сессии дня
    - day_live: в момент start первой сессии дня
    - day_end: через offset_minutes после последней сессии дня
    Пропускает дубли. fire_at всегда в UTC.
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    templates = await db.fetch(
        """
        SELECT id, type, schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before
        FROM broadcast_templates WHERE event_id=$1
        """,
        event_id
    )
    tmpl_map = {t["type"]: t for t in templates}

    if not tmpl_map:
        raise HTTPException(status_code=400, detail="Сначала создайте шаблоны рассылок")

    sessions = await db.fetch(
        """
        SELECT cs.id, cs.start_datetime, cs.end_datetime, cs.title, cs.day
        FROM conf_sessions cs
        WHERE cs.event_id = $1
          AND cs.start_datetime IS NOT NULL
        ORDER BY cs.day, cs.start_datetime
        """,
        event_id
    )

    created = 0
    skipped = 0

    async def add_schedule(tmpl, fire_at, session_id=None, sched_type=None):
        nonlocal created, skipped
        t = sched_type or tmpl["type"]
        if session_id:
            # Для спикерских рассылок — дубль по session_id + type
            exists = await db.fetchval(
                """SELECT 1 FROM broadcast_schedules
                   WHERE event_id=$1 AND template_id=$2 AND session_id=$3 AND type=$4""",
                event_id, tmpl["id"], session_id, t
            )
        else:
            # Для дневных рассылок — дубль по fire_at + type (каждый день имеет своё время)
            exists = await db.fetchval(
                """SELECT 1 FROM broadcast_schedules
                   WHERE event_id=$1 AND template_id=$2 AND fire_at=$3 AND type=$4""",
                event_id, tmpl["id"], fire_at, t
            )
        if exists:
            skipped += 1
            return
        await db.execute(
            """
            INSERT INTO broadcast_schedules
              (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude)
            VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)
            """,
            event_id, session_id, tmpl["id"], t, fire_at,
            tmpl["audience_include"], tmpl["audience_exclude"]
        )
        created += 1

    # ── speaker_intro: одна запись на каждого спикера с рассчитанным fire_at ──
    if "speaker_intro" in tmpl_map:
        tmpl = tmpl_map["speaker_intro"]

        # Настройки из шаблона
        start_time_str = tmpl["intro_start_time"] or "11:00"
        interval_min = tmpl["intro_interval_min"] or 15
        days_before = tmpl["intro_days_before"] or 1

        # Получаем первый день конференции
        first_day = await db.fetchrow(
            "SELECT day_date FROM conf_days WHERE event_id=$1 ORDER BY day_number LIMIT 1",
            event_id
        )

        # Получаем всех спикеров события по полю priority
        speakers_list = await db.fetch(
            """SELECT id FROM conf_speaker_events
               WHERE event_id=$1 AND is_visible=true
               ORDER BY priority, sort_order, id""",
            event_id
        )

        if first_day and first_day["day_date"] and speakers_list:
            from datetime import date, time as dtime
            tz_msk = ZoneInfo("Europe/Moscow")
            h, m = map(int, start_time_str.split(":"))
            conf_date = first_day["day_date"]
            start_date = conf_date - timedelta(days=days_before)
            base_dt = datetime(start_date.year, start_date.month, start_date.day, h, m, 0, tzinfo=tz_msk)

            for i, sp in enumerate(speakers_list):
                fire_at = base_dt + timedelta(minutes=interval_min * i)
                # Дубль по speaker_event_id + type
                exists = await db.fetchval(
                    """SELECT 1 FROM broadcast_schedules
                       WHERE event_id=$1 AND type='speaker_intro' AND session_id=$2""",
                    event_id, sp["id"]
                )
                if exists:
                    skipped += 1
                    continue
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude)
                    VALUES ($1, $2, $3, 'speaker_intro', $4, 'draft', $5, $6)
                    """,
                    event_id, sp["id"], tmpl["id"], fire_at,
                    tmpl["audience_include"], tmpl["audience_exclude"]
                )
                created += 1
        else:
            # Нет дней или спикеров — создаём одну запись без времени как раньше
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='speaker_intro' AND session_id IS NULL",
                event_id
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude)
                    VALUES ($1, NULL, $2, 'speaker_intro', NULL, 'draft', $3, $4)
                    """,
                    event_id, tmpl["id"], tmpl["audience_include"], tmpl["audience_exclude"]
                )
                created += 1
            else:
                skipped += 1

    # ── Группируем сессии по дням ──
    days: dict = {}
    for s in sessions:
        d = s["day"] or 1
        days.setdefault(d, []).append(s)

    # ── pre_start и gift — по каждой сессии со спикером ──
    sessions_with_speaker = await db.fetch(
        """
        SELECT cs.id, cs.start_datetime, cs.end_datetime, cs.day
        FROM conf_sessions cs
        WHERE cs.event_id = $1
          AND cs.speaker_id IS NOT NULL
          AND cs.start_datetime IS NOT NULL
        ORDER BY cs.day, cs.start_datetime
        """,
        event_id
    )

    for s in sessions_with_speaker:
        if "pre_start" in tmpl_map:
            tmpl = tmpl_map["pre_start"]
            offset = tmpl["offset_minutes"] or 5
            fire_at = s["start_datetime"] - timedelta(minutes=offset)
            await add_schedule(tmpl, fire_at, s["id"], "pre_start")

        if "gift" in tmpl_map and s["end_datetime"]:
            tmpl = tmpl_map["gift"]
            offset = tmpl["offset_minutes"] or 5
            fire_at = s["end_datetime"] - timedelta(minutes=offset)
            await add_schedule(tmpl, fire_at, s["id"], "gift")

    # ── day_* — по первой/последней сессии каждого дня ──
    for day_num, day_sessions in days.items():
        first_session = day_sessions[0]
        last_session = day_sessions[-1]

        for ttype in ("day_start_30min_unreg", "day_start_30min_reg"):
            if ttype in tmpl_map and first_session["start_datetime"]:
                tmpl = tmpl_map[ttype]
                offset = tmpl["offset_minutes"] or 30
                fire_at = first_session["start_datetime"] - timedelta(minutes=offset)
                await add_schedule(tmpl, fire_at, None, ttype)

        if "day_live" in tmpl_map and first_session["start_datetime"]:
            tmpl = tmpl_map["day_live"]
            offset = tmpl["offset_minutes"] or 5
            fire_at = first_session["start_datetime"] - timedelta(minutes=offset)
            await add_schedule(tmpl, fire_at, None, "day_live")

        if "day_end" in tmpl_map and last_session.get("end_datetime"):
            tmpl = tmpl_map["day_end"]
            offset = tmpl["offset_minutes"] or 30
            fire_at = last_session["end_datetime"] + timedelta(minutes=offset)
            await add_schedule(tmpl, fire_at, None, "day_end")

    return {"ok": True, "created": created, "skipped": skipped}


class SetFireAtRequest(BaseModel):
    fire_at: str   # ISO datetime строка
    is_test: bool = False


@router.put("/schedules/{schedule_id}/fire-at", summary="Установить время отправки (для custom_datetime)")
async def set_schedule_fire_at(
    event_id: int,
    schedule_id: int,
    data: SetFireAtRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    # Парсим дату — принимаем локальное время клиента (МСК), сохраняем в UTC
    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
    tz = ZoneInfo(tz_str)

    try:
        dt_naive = datetime.fromisoformat(data.fire_at)
        if dt_naive.tzinfo is None:
            dt_aware = dt_naive.replace(tzinfo=tz)
        else:
            dt_aware = dt_naive
        dt_utc = dt_aware.astimezone(ZoneInfo("UTC"))
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат даты. Используйте ISO 8601, например 2026-04-21T14:30:00")

    row = await db.fetchrow(
        """
        UPDATE broadcast_schedules
        SET fire_at=$1, is_test=$2, status='draft'
        WHERE id=$3 AND event_id=$4
        RETURNING id, fire_at, is_test, status
        """,
        dt_utc, data.is_test, schedule_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    return dict(row)


class AddManualRequest(BaseModel):
    template_id: int
    fire_at: str
    is_test: bool = False
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    note: Optional[str] = None


@router.post("/schedules/add-manual", summary="Добавить рассылку вручную")
async def add_manual_schedule(
    event_id: int,
    data: AddManualRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    tpl = await db.fetchrow(
        "SELECT id, type, audience_include, audience_exclude FROM broadcast_templates WHERE id=$1 AND event_id=$2",
        data.template_id, event_id
    )
    if not tpl:
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
    tz = ZoneInfo(tz_str)

    try:
        dt_naive = datetime.fromisoformat(data.fire_at)
        if dt_naive.tzinfo is None:
            dt_aware = dt_naive.replace(tzinfo=tz)
        else:
            dt_aware = dt_naive
        dt_utc = dt_aware.astimezone(ZoneInfo("UTC"))
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат даты")

    aud_include = data.audience_include or tpl["audience_include"]
    aud_exclude = data.audience_exclude if data.audience_exclude is not None else tpl["audience_exclude"]
    row = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, template_id, type, fire_at, status, is_test, audience_include, audience_exclude)
        VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
        RETURNING id, type, fire_at, status, is_test, audience_include, audience_exclude
        """,
        event_id, tpl["id"], tpl["type"], dt_utc, data.is_test, aud_include, aud_exclude
    )
    return dict(row)


@router.post("/schedules/run-all", summary="Запустить всю очередь (активировать Celery)")
async def run_all_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Переводит все draft-рассылки в pending — Celery Beat подхватит их в течение следующей минуты.
    Рассылки с fire_at в прошлом уйдут немедленно при следующем тике Beat.
    Рассылки с fire_at в будущем уйдут по расписанию.
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    # Проверяем есть ли draft-рассылки без времени (fire_at = NULL)
    null_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='draft' AND fire_at IS NULL",
        event_id
    )
    if null_fire and null_fire > 0:
        raise HTTPException(
            status_code=400,
            detail=f"У {null_fire} рассылок не задано время отправки. Установите дату для «Знакомства со спикерами» перед запуском."
        )

    # Переводим draft → pending
    await db.execute(
        "UPDATE broadcast_schedules SET status='pending' WHERE event_id=$1 AND status='draft' AND fire_at IS NOT NULL",
        event_id
    )

    count = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='pending'", event_id
    )
    # Celery Beat сам подхватит по расписанию — нам не нужно ничего дополнительно делать.
    return {"ok": True, "queued": count, "message": f"Очередь активирована. {count} рассылок уйдут по расписанию."}


@router.post("/schedules/run-selected", summary="Запустить выбранные рассылки")
async def run_selected_schedules(
    event_id: int,
    body: dict,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    ids = [int(i) for i in (body.get("ids") or [])]
    if not ids:
        raise HTTPException(status_code=400, detail="Не указаны ID рассылок")

    null_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE id = ANY($1::int[]) AND event_id=$2 AND status='draft' AND fire_at IS NULL",
        ids, event_id
    )
    if null_fire and null_fire > 0:
        raise HTTPException(
            status_code=400,
            detail=f"У {null_fire} выбранных рассылок не задано время отправки."
        )

    await db.execute(
        "UPDATE broadcast_schedules SET status='pending' WHERE id = ANY($1::int[]) AND event_id=$2 AND status='draft' AND fire_at IS NOT NULL",
        ids, event_id
    )
    count = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE id = ANY($1::int[]) AND event_id=$2 AND status='pending'",
        ids, event_id
    )
    return {"ok": True, "queued": count}


@router.post("/schedules/{schedule_id}/cancel", summary="Отменить рассылку")
async def cancel_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    await db.execute(
        "UPDATE broadcast_schedules SET status='cancelled' WHERE id=$1 AND event_id=$2 AND status IN ('pending','draft')",
        schedule_id, event_id
    )
    return {"ok": True}


@router.post("/schedules/cancel-all", summary="Отменить все pending/draft рассылки")
async def cancel_all_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    count = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status IN ('pending','draft')", event_id
    )
    await db.execute(
        "UPDATE broadcast_schedules SET status='cancelled' WHERE event_id=$1 AND status IN ('pending','draft')", event_id
    )
    return {"ok": True, "cancelled": count}


@router.delete("/schedules/{schedule_id}", summary="Удалить рассылку из очереди")
async def delete_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    row = await db.fetchrow(
        "SELECT status FROM broadcast_schedules WHERE id=$1 AND event_id=$2",
        schedule_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Не найдено")
    if row["status"] in ("pending", "running"):
        raise HTTPException(status_code=400, detail="Нельзя удалить активную рассылку. Сначала отмените её.")
    await db.execute("DELETE FROM broadcast_schedules WHERE id=$1", schedule_id)
    return {"ok": True}


@router.post("/schedules/{schedule_id}/copy", summary="Создать копию задачи в очереди")
async def copy_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    row = await db.fetchrow(
        "SELECT * FROM broadcast_schedules WHERE id=$1 AND event_id=$2", schedule_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Задача не найдена")

    new_id = await db.fetchval(
        """INSERT INTO broadcast_schedules
           (event_id, template_id, session_id, day, audience_include, audience_exclude,
            fire_at, status, is_test)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
           RETURNING id""",
        row["event_id"], row["template_id"], row["session_id"], row["day"],
        row["audience_include"], row["audience_exclude"],
        row["fire_at"], row["is_test"]
    )
    return {"ok": True, "id": new_id}


@router.get("/schedules/{schedule_id}/preview", summary="Превью сообщения рассылки")
async def preview_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Возвращает текст и фото, которые получит пользователь,
    собранные из актуальных данных БД прямо сейчас.
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    schedule = await db.fetchrow(
        """
        SELECT bs.*, bt.text as tmpl_text, bt.photo_url as tmpl_photo,
               bt.button_text as tmpl_btn_text, bt.button_url as tmpl_btn_url,
               bt.type as tmpl_type
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        WHERE bs.id=$1 AND bs.event_id=$2
        """,
        schedule_id, event_id
    )
    if not schedule:
        raise HTTPException(status_code=404, detail="Не найдено")

    tpl_type = schedule["tmpl_type"] or schedule["type"]
    text = schedule["tmpl_text"] or ""
    photo = schedule["tmpl_photo"]
    btn_text = schedule["tmpl_btn_text"]
    btn_url = schedule["tmpl_btn_url"] or ""

    DAY_TYPES = ("day_start_30min_unreg", "day_start_30min_reg", "day_live", "day_end")

    if tpl_type in DAY_TYPES:
        # Определяем день по fire_at рассылки
        client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
        tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")

        # Находим day_number по fire_at: ищем ближайшую сессию того же дня
        fire_at = schedule["fire_at"]
        if fire_at:
            fire_local = fire_at.astimezone(tz)
            fire_date = fire_local.date()
            # Находим первую сессию с той же датой
            day_row = await db.fetchrow(
                """
                SELECT cs.day FROM conf_sessions cs
                WHERE cs.event_id=$1 AND DATE(cs.start_datetime AT TIME ZONE $2) = $3
                ORDER BY cs.start_datetime LIMIT 1
                """,
                event_id, str(tz), fire_date
            )
            day = day_row["day"] if day_row else 1
        else:
            day = 1

        conf_row = await db.fetchrow(
            """
            SELECT e.title as conf_title, cc.registration_url, cc.raffle_url,
                   cc.poster_horizontal, cd.stream_url, cd.day_date
            FROM events e
            JOIN conf_conferences cc ON cc.event_id = e.id
            LEFT JOIN conf_days cd ON cd.event_id = e.id AND cd.day_number = $2
            WHERE e.id = $1
            """,
            event_id, day
        )
        conf_title = (conf_row["conf_title"] or "") if conf_row else ""
        stream_url = (conf_row["stream_url"] or "") if conf_row else ""
        reg_url = (conf_row["registration_url"] or "") if conf_row else ""
        raffle_url = (conf_row["raffle_url"] or "") if conf_row else ""
        raw_date = conf_row["day_date"] if conf_row else None
        day_date_str = ru_date(raw_date) if raw_date else f"День {day}"
        poster_h = conf_row["poster_horizontal"] if conf_row else None
        if not photo and poster_h:
            photo = poster_h[0] if poster_h else None

        ROLE_LABELS = {"headliner": "Хедлайнер", "partner": "Партнёр", "organizer": "Организатор"}
        day_sessions = await db.fetch(
            """
            SELECT cs.start_datetime, cs.end_datetime, cs.title as session_title,
                   c.name as speaker_name, cse.role
            FROM conf_sessions cs
            LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
            LEFT JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cs.event_id=$1 AND cs.day=$2
            ORDER BY cs.sort_order, cs.start_datetime
            """,
            event_id, day
        )
        program_lines = []
        for s in day_sessions:
            t_start = s["start_datetime"].astimezone(tz).strftime("%H:%M") if s["start_datetime"] else ""
            t_end = s["end_datetime"].astimezone(tz).strftime("%H:%M") if s["end_datetime"] else ""
            time_part = f"{t_start}–{t_end}" if t_start and t_end else t_start
            bold_time = f"<b>{time_part}</b>" if time_part else ""
            topic = s["session_title"] or ""
            name = s["speaker_name"] or ""
            role_label = ROLE_LABELS.get(s["role"] or "", "")
            speaker_part = f" (<b>{name}{' — ' + role_label if role_label else ''}</b>)" if name else ""
            program_lines.append(f"{bold_time}: {topic}{speaker_part}".strip(": "))
        day_program = "\n".join(program_lines)

        ORDINALS = {1: "первом", 2: "втором", 3: "третьем", 4: "четвёртом", 5: "пятом"}
        day_ordinal = ORDINALS.get(day, f"{day}-м")

        # day_end: подарки спикеров
        day_speakers_gifts = ""
        next_day_mention = ""
        if tpl_type == "day_end":
            gift_sessions = await db.fetch(
                """
                SELECT c.name as speaker_name, c.personal_tg_username,
                       cse.gift_after_speech_title, cse.gift_after_speech_url, cse.role, cse.is_commercial
                FROM conf_sessions cs
                JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                JOIN collaborators c ON c.id = cse.speaker_id
                WHERE cs.event_id=$1 AND cs.day=$2
                ORDER BY
                    cse.priority, cs.sort_order
                """,
                event_id, day
            )
            gift_blocks = []
            for gs in gift_sessions:
                title = (gs["gift_after_speech_title"] or "").strip()
                url = (gs["gift_after_speech_url"] or "").strip()
                tg = (gs["personal_tg_username"] or "").strip()
                tg_mention = ("@" + tg.lstrip("@")) if tg else ""
                if not title:
                    block = f"🎁 <b>{gs['speaker_name']}:</b> пишите в личку {tg_mention}" if tg_mention else f"🎁 <b>{gs['speaker_name']}:</b> уточните у спикера"
                elif not url:
                    block = f"🎁 <b>{gs['speaker_name']}:</b> {title}" + (f"\nПишите в личку {tg_mention}" if tg_mention else "")
                else:
                    block = f"🎁 <b>{gs['speaker_name']}:</b> {title}\n{url}"
                gift_blocks.append(block)
            if gift_blocks:
                day_speakers_gifts = f"А сейчас ловите подарки от спикеров Дня {day}:\n\n" + "\n\n".join(gift_blocks)

            # Следующий день
            MONTHS_RU = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"]
            first_next = await db.fetchrow(
                "SELECT start_datetime FROM conf_sessions WHERE event_id=$1 AND day=$2 ORDER BY sort_order, start_datetime LIMIT 1",
                event_id, day + 1
            )
            first_cur = await db.fetchrow(
                "SELECT start_datetime FROM conf_sessions WHERE event_id=$1 AND day=$2 ORDER BY sort_order, start_datetime LIMIT 1",
                event_id, day
            )
            if first_next and first_next["start_datetime"]:
                next_dt = first_next["start_datetime"].astimezone(tz)
                next_time = next_dt.strftime("%H:%M")
                next_date = next_dt.date()
                cur_date2 = first_cur["start_datetime"].astimezone(tz).date() if first_cur and first_cur["start_datetime"] else None
                diff = (next_date - cur_date2).days if cur_date2 else 999
                when = "завтра" if diff == 1 else f"{next_date.day} {MONTHS_RU[next_date.month - 1]}"
                next_day_mention = f"Встречаемся {when} в {next_time} на День {day + 1}."

        text = text.replace("{conf_title}", conf_title)
        text = text.replace("{day_number}", str(day))
        text = text.replace("{day_ordinal}", day_ordinal)
        text = text.replace("{day_date}", day_date_str)
        text = text.replace("{day_program}", day_program)
        text = text.replace("{stream_url}", stream_url)
        text = text.replace("{registration_url}", reg_url)
        text = text.replace("{raffle_url}", raffle_url)
        text = text.replace("{day_speakers_gifts}", day_speakers_gifts)
        if next_day_mention:
            text = text.replace("{next_day_mention}", next_day_mention)
        else:
            text = re.sub(r"^.*\{next_day_mention\}.*$\n?", "", text, flags=re.MULTILINE)
        if not day_speakers_gifts:
            text = re.sub(r"^.*\{day_speakers_gifts\}.*$\n?", "", text, flags=re.MULTILINE)
        btn_url = btn_url.replace("{stream_url}", stream_url).replace("{registration_url}", reg_url)

    elif tpl_type == "speaker_intro":
        # session_id хранит conf_speaker_events.id
        if schedule["session_id"]:
            sp = await db.fetchrow(
                """
                SELECT c.name as speaker_name, c.poster_url as speaker_poster,
                       c.personal_tg_username, c.tg_channel_url, c.instagram_url,
                       c.achievements,
                       cse.role, cse.gift_after_speech_title, cse.gift_after_speech_url,
                       cse.gift_raffle_title,
                       cc.registration_url
                FROM conf_speaker_events cse
                JOIN collaborators c ON c.id = cse.speaker_id
                LEFT JOIN conf_conferences cc ON cc.event_id = cse.event_id
                WHERE cse.id=$1
                """,
                schedule["session_id"]
            )
            if sp:
                topics = await db.fetch(
                    "SELECT topic FROM conf_speaker_topics WHERE cse_id=$1 ORDER BY sort_order LIMIT 1",
                    schedule["session_id"]
                )
                topic = (topics[0]["topic"] if topics else "").strip()
                if not photo:
                    photo = sp["speaker_poster"]

                text = build_speaker_intro_message(
                    text, sp["speaker_name"], sp["personal_tg_username"],
                    sp["tg_channel_url"], sp["instagram_url"],
                    sp["achievements"], sp["role"],
                    topic, sp["gift_after_speech_title"],
                    sp["gift_raffle_title"], sp["registration_url"]
                )

    else:
        # Спикерские шаблоны (pre_start, gift)
        session_data = {}
        if schedule["session_id"]:
            session = await db.fetchrow(
                """
                SELECT cs.title as session_title, cs.start_datetime, cs.end_datetime, cs.day,
                       c.name as speaker_name, c.poster_url as speaker_poster,
                       c.personal_tg_username as speaker_personal_tg,
                       cse.gift_after_speech_title as gift_title,
                       cse.gift_after_speech_url as gift_url,
                       cd.stream_url
                FROM conf_sessions cs
                LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                LEFT JOIN collaborators c ON c.id = cse.speaker_id
                LEFT JOIN conf_days cd ON cd.event_id = cs.event_id AND cd.day_number = cs.day
                WHERE cs.id=$1
                """,
                schedule["session_id"]
            )
            if session:
                session_data = dict(session)
        if not photo:
            photo = session_data.get("speaker_poster")
        replacements = {
            "{speaker_name}": session_data.get("speaker_name") or "",
            "{session_title}": session_data.get("session_title") or "",
            "{speaker_topic}": session_data.get("session_title") or "",
            "{stream_url}": session_data.get("stream_url") or "",
            "{gift_title}": (session_data.get("gift_title") or "").strip(),
            "{gift_url}": (session_data.get("gift_url") or "").strip(),
        }
        for k, v in replacements.items():
            text = text.replace(k, v)

    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    return {
        "text": text,
        "photo": photo,
        "button_text": btn_text,
        "button_url": btn_url,
        "template_type": tpl_type,
    }


# ─────────────────────────────────────────
# ТЕСТОВАЯ РАССЫЛКА
# ─────────────────────────────────────────

@router.post("/templates/{template_id}/test", summary="Тестовая рассылка шаблона")
async def test_template(
    event_id: int,
    template_id: int,
    day: int = 1,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    import httpx, re

    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    tpl = await db.fetchrow(
        "SELECT * FROM broadcast_templates WHERE id=$1 AND event_id=$2", template_id, event_id
    )
    if not tpl:
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    DAY_TYPES = ("day_start_30min_unreg", "day_start_30min_reg", "day_live", "day_end")
    SPEAKER_TYPES = ("gift", "speaker_intro", "pre_start")
    if tpl["type"] not in SPEAKER_TYPES + DAY_TYPES:
        return {"ok": False, "reason": "not_implemented", "message": "Тестовая отправка для этого шаблона пока не реализована"}

    client_row = await db.fetchrow(
        "SELECT bot_token, test_telegram_ids FROM clients WHERE id=$1", client_id
    )
    bot_token = (client_row["bot_token"] or "").strip() if client_row else ""
    if not bot_token:
        raise HTTPException(status_code=400, detail="Токен бота не задан в настройках")
    test_ids = client_row["test_telegram_ids"] or []
    if not test_ids:
        raise HTTPException(status_code=400, detail="Тестовые Telegram ID не заданы в настройках")

    def build_gift_message(speaker_name, personal_tg, gift_title, gift_url):
        tg_raw = (personal_tg or "").strip()
        tg_mention = ("@" + tg_raw.lstrip("@")) if tg_raw else ""
        title = (gift_title or "").strip()
        url = (gift_url or "").strip()
        header = f"🎁 {speaker_name}: Подарки после эфира"
        if not title:
            body = f"🎁 Чтобы забрать материалы — пишите в личку {tg_mention}" if tg_mention else "🎁 Чтобы забрать материалы — напишите спикеру в личку"
        elif not url:
            body = f"{title}\nПишите в личку {tg_mention}" if tg_mention else title
        else:
            body = f"{title}\n{url}"
        return f"{header}\n\n{body}"

    def build_pre_start_message(tmpl_text, speaker_name, speaker_topic, stream_url_val):
        text = tmpl_text or ""
        text = text.replace("{speaker_name}", speaker_name or "")
        text = text.replace("{speaker_topic}", speaker_topic or "")
        text = text.replace("{stream_url}", stream_url_val or "")
        return text.strip()

    ORDINALS = {1: "первом", 2: "втором", 3: "третьем", 4: "четвёртом", 5: "пятом"}

    def build_day_message(tmpl_text, day_number, conf_title, day_date, day_program,
                          stream_url_val, registration_url_val, raffle_url_val="", day_speakers_gifts="",
                          next_day_mention=""):
        text = tmpl_text or ""
        ordinal = ORDINALS.get(day_number, f"{day_number}-м")
        text = text.replace("{day_number}", str(day_number))
        text = text.replace("{day_ordinal}", ordinal)
        text = text.replace("{conf_title}", conf_title or "")
        text = text.replace("{day_date}", day_date or "")
        text = text.replace("{day_program}", day_program or "")
        text = text.replace("{stream_url}", stream_url_val or "")
        text = text.replace("{registration_url}", registration_url_val or "")
        text = text.replace("{raffle_url}", raffle_url_val or "")
        text = text.replace("{day_speakers_gifts}", day_speakers_gifts or "")
        if next_day_mention:
            text = text.replace("{next_day_mention}", next_day_mention)
        else:
            text = re.sub(r"^.*\{next_day_mention\}.*$\n?", "", text, flags=re.MULTILINE)
        return re.sub(r"\n{3,}", "\n\n", text).strip()

    if tpl["type"] in ("day_start_30min_unreg", "day_start_30min_reg", "day_live", "day_end"):
        client_row_tz = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
        tz = ZoneInfo((client_row_tz["timezone"] or "Europe/Moscow") if client_row_tz else "Europe/Moscow")

        conf_row = await db.fetchrow(
            """
            SELECT e.title as conf_title,
                   cc.registration_url,
                   cc.raffle_url,
                   cc.poster_horizontal,
                   cd.stream_url,
                   cd.day_date
            FROM events e
            JOIN conf_conferences cc ON cc.event_id = e.id
            LEFT JOIN conf_days cd ON cd.event_id = e.id AND cd.day_number = $2
            WHERE e.id = $1
            """,
            event_id, day
        )
        conf_title = conf_row["conf_title"] if conf_row else ""
        registration_url = (conf_row["registration_url"] or "") if conf_row else ""
        raffle_url = (conf_row["raffle_url"] or "") if conf_row else ""
        stream_url = (conf_row["stream_url"] or "") if conf_row else ""
        raw_date = conf_row["day_date"] if conf_row else None
        day_date_str = ru_date(raw_date) if raw_date else f"День {day}"
        poster_h = conf_row["poster_horizontal"] if conf_row else None
        photo = tpl["photo_url"] or (poster_h[0] if poster_h else None) or None

        ROLE_LABELS = {"headliner": "Хедлайнер", "partner": "Партнёр", "organizer": "Организатор"}
        day_sessions = await db.fetch(
            """
            SELECT cs.start_datetime, cs.end_datetime,
                   cs.title as session_title,
                   c.name as speaker_name,
                   cse.role
            FROM conf_sessions cs
            LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
            LEFT JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cs.event_id = $1 AND cs.day = $2
            ORDER BY cs.sort_order, cs.start_datetime
            """,
            event_id, day
        )
        program_lines = []
        for s in day_sessions:
            t_start = s["start_datetime"].astimezone(tz).strftime("%H:%M") if s["start_datetime"] else ""
            t_end = s["end_datetime"].astimezone(tz).strftime("%H:%M") if s["end_datetime"] else ""
            time_part = f"{t_start}-{t_end}" if t_start and t_end else t_start
            bold_time = f"<b>{time_part}</b>" if time_part else ""
            topic = s["session_title"] or ""
            name = s["speaker_name"] or ""
            role = s["role"] or ""
            role_label = ROLE_LABELS.get(role, "")
            speaker_part = f" (<b>{name}{' — ' + role_label if role_label else ''}</b>)" if name else ""
            program_lines.append(f"{bold_time}: {topic}{speaker_part}".strip(": "))
        day_program = "\n".join(program_lines)

        day_speakers_gifts = ""
        next_day_mention = ""
        if tpl["type"] == "day_end":
            gift_sessions = await db.fetch(
                """
                SELECT c.name as speaker_name, c.personal_tg_username,
                       cse.gift_after_speech_title, cse.gift_after_speech_url,
                       cse.role, cse.is_commercial
                FROM conf_sessions cs
                JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                JOIN collaborators c ON c.id = cse.speaker_id
                WHERE cs.event_id = $1 AND cs.day = $2
                ORDER BY
                    CASE
                        WHEN cse.priority IS NOT NULL THEN cse.priority
                        WHEN cse.role = 'organizer'                              THEN 10
                        WHEN cse.is_commercial AND cse.role = 'headliner'        THEN 20
                        WHEN cse.is_commercial AND cse.role = 'speaker'          THEN 30
                        WHEN cse.is_commercial AND cse.role = 'partner'          THEN 40
                        WHEN NOT cse.is_commercial AND cse.role = 'headliner'    THEN 50
                        WHEN NOT cse.is_commercial AND cse.role = 'speaker'      THEN 60
                        WHEN NOT cse.is_commercial AND cse.role = 'partner'      THEN 70
                        ELSE 8
                    END,
                    cs.sort_order
                """,
                event_id, day
            )
            gift_blocks = []
            for gs in gift_sessions:
                title = (gs["gift_after_speech_title"] or "").strip()
                url = (gs["gift_after_speech_url"] or "").strip()
                tg_raw = (gs["personal_tg_username"] or "").strip()
                tg_mention = ("@" + tg_raw.lstrip("@")) if tg_raw else ""
                if not title:
                    block = f"🎁 <b>{gs['speaker_name']}:</b> пишите в личку {tg_mention}" if tg_mention else f"🎁 <b>{gs['speaker_name']}:</b> уточните у спикера"
                elif not url:
                    block = f"🎁 <b>{gs['speaker_name']}:</b> {title}\n{('Пишите в личку ' + tg_mention) if tg_mention else ''}".strip()
                else:
                    block = f"🎁 <b>{gs['speaker_name']}:</b> {title}\n{url}"
                gift_blocks.append(block)
            if gift_blocks:
                day_speakers_gifts = f"А сейчас ловите подарки от спикеров Дня {day}:\n\n" + "\n\n".join(gift_blocks)

            MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня",
                         "июля", "августа", "сентября", "октября", "ноября", "декабря"]
            next_day_number = day + 1
            first_cur_session = await db.fetchrow(
                "SELECT start_datetime FROM conf_sessions WHERE event_id = $1 AND day = $2 ORDER BY sort_order, start_datetime LIMIT 1",
                event_id, day
            )
            first_next_session = await db.fetchrow(
                "SELECT start_datetime FROM conf_sessions WHERE event_id = $1 AND day = $2 ORDER BY sort_order, start_datetime LIMIT 1",
                event_id, next_day_number
            )
            if first_next_session and first_next_session["start_datetime"]:
                next_dt = first_next_session["start_datetime"].astimezone(tz)
                next_time = next_dt.strftime("%H:%M")
                next_date = next_dt.date()
                cur_date = first_cur_session["start_datetime"].astimezone(tz).date() if first_cur_session and first_cur_session["start_datetime"] else None
                diff = (next_date - cur_date).days if cur_date else 999
                if diff == 1:
                    when = "завтра"
                else:
                    when = f"{next_date.day} {MONTHS_RU[next_date.month - 1]}"
                next_day_mention = f"Встречаемся {when} в {next_time} на День {next_day_number}."

        text = build_day_message(
            tpl["text"], day, conf_title, day_date_str, day_program, stream_url, registration_url,
            raffle_url_val=raffle_url, day_speakers_gifts=day_speakers_gifts,
            next_day_mention=next_day_mention
        )
        btn_text = tpl["button_text"]
        btn_url = (tpl["button_url"] or "").replace("{stream_url}", stream_url).replace("{registration_url}", registration_url).replace("{raffle_url}", raffle_url)
        reply_markup = None
        if btn_text and btn_url and not btn_url.startswith("{"):
            reply_markup = {"inline_keyboard": [[{"text": btn_text, "url": btn_url}]]}

        TYPE_LABELS = {
            "day_start_30min_unreg": "незарегистрированные",
            "day_start_30min_reg": "зарегистрированные",
            "day_live": "старт эфира",
            "day_end": "итоги дня",
        }
        label = f"День {day} — {TYPE_LABELS.get(tpl['type'], tpl['type'])}"
        send_results = []
        async with httpx.AsyncClient(timeout=15) as http:
            for chat_id in test_ids:
                ok = True
                err = None
                if photo and len(text) <= 1024:
                    payload = {"chat_id": chat_id, "photo": photo, "caption": text, "parse_mode": "HTML"}
                    if reply_markup:
                        payload["reply_markup"] = reply_markup
                    resp = await http.post(f"https://api.telegram.org/bot{bot_token}/sendPhoto", json=payload)
                    r = resp.json()
                    ok = r.get("ok")
                    err = r.get("description")
                elif photo:
                    resp1 = await http.post(f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                        json={"chat_id": chat_id, "photo": photo})
                    resp2 = await http.post(f"https://api.telegram.org/bot{bot_token}/sendMessage",
                        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                              "disable_web_page_preview": True,
                              **({"reply_markup": reply_markup} if reply_markup else {})})
                    r = resp2.json()
                    ok = resp1.json().get("ok") and r.get("ok")
                    err = r.get("description")
                else:
                    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
                    if reply_markup:
                        payload["reply_markup"] = reply_markup
                    resp = await http.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
                    r = resp.json()
                    ok = r.get("ok")
                    err = r.get("description")
                if not ok:
                    import logging
                    logging.getLogger(__name__).warning(f"[broadcast test] chat_id={chat_id} error={err}")
                send_results.append({"chat_id": chat_id, "ok": ok, "error": err})

        return {"ok": True, "sent": 1, "details": [{"speaker": label, "results": send_results}]}

    # ── Ветка: шаблоны уровня «спикер» ──

    conf_row2 = await db.fetchrow(
        "SELECT cc.registration_url FROM conf_conferences cc WHERE cc.event_id = $1", event_id
    )
    registration_url_val = (conf_row2["registration_url"] or "") if conf_row2 else ""

    sessions = await db.fetch(
        """
        SELECT cs.sort_order, cs.title as speaker_topic,
               c.name as speaker_name,
               c.personal_tg_username,
               c.tg_channel_url,
               c.instagram_url,
               c.achievements,
               c.poster_url as speaker_poster,
               cse.role,
               cse.gift_after_speech_title as gift_title,
               cse.gift_after_speech_url as gift_url,
               cse.gift_raffle_title,
               COALESCE(cd.stream_url, '') as stream_url
        FROM conf_sessions cs
        JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
        JOIN collaborators c ON c.id = cse.speaker_id
        LEFT JOIN conf_days cd ON cd.event_id = cs.event_id AND cd.day_number = cs.day
        WHERE cs.event_id = $1 AND cs.day = $2 AND cs.speaker_id IS NOT NULL
        ORDER BY cs.sort_order
        """,
        event_id, day
    )

    results = []
    async with httpx.AsyncClient(timeout=15) as http:
        for s in sessions:
            if tpl["type"] == "gift":
                text = build_gift_message(s["speaker_name"], s["personal_tg_username"], s["gift_title"], s["gift_url"])
                photo = None
            elif tpl["type"] == "speaker_intro":
                text = build_speaker_intro_message(
                    tpl["text"], s["speaker_name"], s["personal_tg_username"],
                    s["tg_channel_url"], s["instagram_url"],
                    s["achievements"], s["role"],
                    s["speaker_topic"], s["gift_title"],
                    s["gift_raffle_title"], registration_url_val
                )
                photo = s["speaker_poster"] or tpl["photo_url"] or None
            elif tpl["type"] == "pre_start":
                text = build_pre_start_message(tpl["text"], s["speaker_name"], s["speaker_topic"], s["stream_url"])
                photo = s["speaker_poster"] or tpl["photo_url"] or None
            else:
                continue

            reply_markup = None
            btn_text = tpl["button_text"]
            btn_url = (tpl["button_url"] or "").replace("{stream_url}", s["stream_url"]).replace("{registration_url}", registration_url_val)
            if btn_text and btn_url:
                reply_markup = {"inline_keyboard": [[{"text": btn_text, "url": btn_url}]]}

            speaker_results = []
            for chat_id in test_ids:
                if photo and len(text) <= 1024:
                    payload = {"chat_id": chat_id, "photo": photo, "caption": text, "parse_mode": "HTML"}
                    if reply_markup:
                        payload["reply_markup"] = reply_markup
                    resp = await http.post(f"https://api.telegram.org/bot{bot_token}/sendPhoto", json=payload)
                    r = resp.json()
                    ok, err = r.get("ok"), r.get("description")
                elif photo:
                    await http.post(f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                        json={"chat_id": chat_id, "photo": photo})
                    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
                    if reply_markup:
                        payload["reply_markup"] = reply_markup
                    resp = await http.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
                    r = resp.json()
                    ok, err = r.get("ok"), r.get("description")
                else:
                    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
                    if reply_markup:
                        payload["reply_markup"] = reply_markup
                    resp = await http.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
                    r = resp.json()
                    ok, err = r.get("ok"), r.get("description")
                speaker_results.append({"chat_id": chat_id, "ok": ok, "error": err})
            results.append({"speaker": s["speaker_name"], "results": speaker_results})

    return {"ok": True, "sent": len(sessions), "details": results}


# ─────────────────────────────────────────
# Хелпер
# ─────────────────────────────────────────
async def _check_event(db, event_id: int, client_id: int):
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id=$1 AND client_id=$2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
