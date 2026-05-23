from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, time, timedelta
import asyncpg
import httpx
import re
from zoneinfo import ZoneInfo


def _msk_str_to_utc(day_date, hhmm) -> Optional[datetime]:
    """Собирает UTC datetime из day_date (DATE) + строки "HH:MM" в МСК.
    Используется только под капотом для расчёта fire_at — пользователь видит только строку времени."""
    if not day_date or not hhmm:
        return None
    s = str(hhmm)[:5]
    if len(s) != 5 or s[2] != ":":
        return None
    h, m = int(s[:2]), int(s[3:])
    msk_naive = datetime.combine(day_date, time(h, m))
    # МСК = UTC+3 → вычитаем 3 часа и проставляем UTC.
    return (msk_naive - timedelta(hours=3)).replace(tzinfo=ZoneInfo("UTC"))

from app.database import get_db
from app.auth import get_current_client
from app.services.message_builder import (
    build_speaker_intro_message,
    build_gift_message,
    build_pre_start_message,
    build_day_message,
    build_message_content,
    send_telegram_message,
)
from app.services import collaborator_sort

RU_MONTHS = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля",
    5: "мая", 6: "июня", 7: "июля", 8: "августа",
    9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
}

def ru_date(d) -> str:
    return f"{d.day} {RU_MONTHS[d.month]}"

router = APIRouter(prefix="/events/{event_id}/broadcasts", tags=["Рассылки"])


# ─────────────────────────────────────────
# ШАБЛОНЫ
# ─────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    type: str
    subject: Optional[str] = None               # email Subject + жирная первая строка в TG/VK/MAX
    text: Optional[str] = None
    photo_url: Optional[str] = None
    button_text: Optional[str] = None
    button_url: Optional[str] = None
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    custom_day_ref: Optional[str] = None        # 'before_1' | 'day_1' | 'after_1' для type='custom'
    custom_time: Optional[str] = None           # 'HH:MM'
    # Каналы для отправки: NULL/None = все каналы клиента (default), [] = никуда,
    # [N,M] = только эти channel_id. Унаследуется в schedules через generate_schedules.
    target_channel_ids: Optional[List[int]] = None


class TemplateUpdate(BaseModel):
    name: str
    type: str
    subject: Optional[str] = None
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
    custom_day_ref: Optional[str] = None        # для type='custom'
    custom_time: Optional[str] = None           # для type='custom'
    target_channel_ids: Optional[List[int]] = None


DEFAULT_TEMPLATES = [
    {
        "name": "Анонс знакомства со спикерами (за день до старта)",
        "type": "pre_conf",
        "text": (
            "Пришло время знакомиться со спикерами!\n\n"
            "Добрейшего-богатейшего!\n\n"
            "Уже послезавтра — <b>{conf_date}</b> мы с вами встречаемся на Большой онлайн-конференции <b>«{conf_title}»</b>\n\n"
            "{conf_description}\n\n"
            "И самое время узнать, каких мощных спикеров мы для вас собрали и сколько ценности они подготовили для вас и каждого зрителя\n\n"
            "А если вы ещё не зарегистрировались — нажимайте на кнопку и забирайте ценные подарки от спикеров!"
        ),
        "photo_url": None,
        "button_text": "Зарегистрироваться",
        "button_url": "{landing_url}",
        "schedule_mode": "custom_datetime",
        "offset_minutes": 0,
        "audience_include": "all_client",
        "audience_exclude": "none",
        "allow_custom_datetime": True,
    },
    {
        # Универсальный текст без упоминания спикера. Подходит и для конференции,
        # и для обычного мероприятия. Если конф хочет «выступает {speaker_name}» —
        # клиент редактирует шаблон вручную.
        "name": "За 5 минут до выступления спикера",
        "type": "5min_before",
        "text": (
            "<b>Через 5 минут стартует «{conf_title}»</b>\n\n"
            "Подключайтесь к эфиру 👇\n\n"
            "🔗 {stream_url}"
        ),
        "photo_url": None,
        "button_text": "Подключиться к эфиру",
        "button_url": "{stream_url}",
        "schedule_mode": "fixed_offset",
        "offset_minutes": 5,
        "audience_include": "all_event",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
    {
        "name": "За 30 минут до старта",
        "type": "30min_before",
        "text": (
            "<b>Через 30 минут стартует «{conf_title}»</b>\n\n"
            "Подключайтесь к эфиру по кнопке ниже 👇\n\n"
            "🔗 {stream_url}"
        ),
        "photo_url": None,
        "button_text": "Подключиться к эфиру",
        "button_url": "{stream_url}",
        "schedule_mode": "fixed_offset",
        "offset_minutes": 30,
        "audience_include": "all_event",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
    {
        # Мероприятие — за 5 минут до старта эфира. Аналог `day_live` в конференции,
        # но без модели «дней»: точка отсчёта — events.start_at.
        "name": "За 5 минут до старта мероприятия",
        "type": "event_live",
        "text": (
            "<b>Через 5 минут стартует «{conf_title}»</b>\n\n"
            "Подключайтесь к эфиру 👇\n\n"
            "🔗 {stream_url}"
        ),
        "photo_url": None,
        "button_text": "Подключиться к эфиру",
        "button_url": "{stream_url}",
        "schedule_mode": "fixed_offset",
        "offset_minutes": 5,
        "audience_include": "all_event",
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
            "🔗 {landing_url} \n\n"
            "<b>Жмите на кнопку</b>"
        ),
        "photo_url": None,
        "button_text": "Зарегистрироваться",
        "button_url": "{landing_url}",
        "schedule_mode": "custom_datetime",
        "offset_minutes": 0,
        "audience_include": "all_client",
        "audience_exclude": "none",
        "allow_custom_datetime": True,
    },
    {
        "name": "За 2 часа (не зарегистрирован)",
        "type": "2h_before_unreg",
        "text": (
            "<b>[Последний шанс зарегистрироваться] Через 2 часа стартует День {day_number} конференции «{conf_title}»</b>\n\n"
            "🔗 {landing_url} \n\n"
            "Сегодня в программе:\n\n"
            "{day_date}\n\n"
            "{day_program}\n\n"
            "Нажимай на кнопку «Зарегистрироваться», чтобы попасть в вебинарную комнату.\n"
            "🔗 {landing_url}\n\n"
            "—\n"
            "При возникновении технических трудностей пишите — @forbs_service2"
        ),
        "photo_url": None,
        "button_text": "Зарегистрироваться",
        "button_url": "{landing_url}",
        "schedule_mode": "day_offset",
        "offset_minutes": 120,
        "audience_include": "all_client",
        "audience_exclude": "registered_event",
        "allow_custom_datetime": False,
    },
    {
        "name": "За 2 часа (зарегистрирован)",
        "type": "2h_before_reg",
        "text": (
            "<b>Уже через 2 часа стартует «{conf_title}»</b>\n\n"
            "Вы записаны — а пока ещё есть время позвать друзей и получить подарки за приведённых.\n\n"
            "🎯 Откройте партнёрский кабинет и забирайте подарки:\n"
            "🔗 {game_link}"
        ),
        "photo_url": None,
        "button_text": "🎁 Получить подарки",
        "button_url": "{game_link}",
        "schedule_mode": "day_offset",
        "offset_minutes": 120,
        "audience_include": "registered_event",
        "audience_exclude": "none",
        "allow_custom_datetime": False,
    },
    {
        "name": "За сутки в 09:12 МСК (не зарегистрирован)",
        "type": "day_before_09_12_unreg",
        "text": (
            "<b>Завтра «{conf_title}»</b>\n\n"
            "Регистрируйтесь по кнопке — встретимся завтра!\n\n"
            "🔗 {landing_url}"
        ),
        "photo_url": None,
        "button_text": "Зарегистрироваться",
        "button_url": "{landing_url}",
        "schedule_mode": "fixed_offset",
        "offset_minutes": 1440,
        "audience_include": "all_client",
        "audience_exclude": "registered_event",
        "allow_custom_datetime": False,
    },
    {
        "name": "За сутки в 09:12 МСК (зарегистрирован)",
        "type": "day_before_09_12_reg",
        "text": (
            "<b>Завтра «{conf_title}»</b>\n\n"
            "Вы записаны — а пока ещё есть время позвать друзей и получить подарки за приведённых.\n\n"
            "🎯 Откройте партнёрский кабинет и забирайте подарки:\n"
            "🔗 {game_link}"
        ),
        "photo_url": None,
        "button_text": "🎁 Получить подарки",
        "button_url": "{game_link}",
        "schedule_mode": "fixed_offset",
        "offset_minutes": 1440,
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
    {
        "name": "Продажа VIP-тарифа",
        "type": "vip_offer",
        "text": (
            "Добрейшего-богатейшего! {first_name}!\n\n"
            "🌟 Главные итоги 1 дня онлайн-конференции iViSiON\n\n"
            "Друзья, первый день конференции завершился.\n"
            "Спасибо за вашу активность, вопросы, энергию и участие. Вы сделали атмосферу мощной и живой ❤️\n\n"
            "Но самое важное — ваше развитие не заканчивается сегодня.\n\n"
            "Вы можете продолжить взаимодействие с нами в следующих форматах:\n\n"
            "🔸 Бесплатный тест-драйв программы «Делай имя и продажи» для экспертов и предпринимателей\n"
            "👉 https://www.margoforbs.ru/dns_stupen1.html\n\n"
            "🔸 Канал Марго Форбс Telegram 👉 https://t.me/margoforbs_business\n"
            "🔸 Канал Марго Форбс MAX 👉 https://max.ru/id890306512862_biz\n\n"
            "👉 Мастермайнд в тарифе VIP с записями выступлений\n"
            "https://medialift.margoforbs.ru/ivision-vip-tarif\n\n"
            "VIP Тариф всего за 4990 руб. позволяет:\n"
            "— получить записи и вернуться к любому выступлению и внедрить всё в удобном ритме;\n"
            "— получить 20 кодовых слов с эфиров для повышения шансов в розыгрыше;\n"
            "— пройти 2-3х часовой практический мастермайнд «Делай имя и продажи». "
            "Каждый участник выстроит стратегию медийности на год через коллаборации с лидерами рынка, "
            "сформулирует большую продающую идею и концепт именного события.\n\n"
            "Выбирайте, что вам подходит — и продолжайте движение вперёд ❤️"
        ),
        "photo_url": None,
        "button_text": "Оплатить VIP",
        "button_url": "https://medialift.margoforbs.ru/ivision-vip-tarif",
        "schedule_mode": "custom_datetime",
        "offset_minutes": 0,
        "audience_include": "all_client",
        "audience_exclude": "none",
        "allow_custom_datetime": True,
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
        SELECT id, name, type, subject, text, photo_url, button_text, button_url,
               schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before,
               custom_day_ref, custom_time,
               target_channel_ids,
               created_at
        FROM broadcast_templates
        WHERE event_id = $1
        ORDER BY type, created_at
        """,
        event_id
    )

    if not rows:
        # Какие типы сидим зависит от типа события:
        #  • Конференция: все «общие» + конф-специфика (pre_conf, speaker_intro, gift, 5min_before per-session, day_live, day_end, vip_offer).
        #  • Мероприятие: только общие (2h_before_*, 30min_before, day_before_09_12_*) + event_live (= аналог 5 минут до старта эфира, но event-level).
        # `5min_before` (за 5 мин до выступления спикера) — только для конференции.
        # `event_live` (за 5 мин до старта мероприятия) — только для мероприятия.
        ev_row = await db.fetchrow("SELECT module_slug FROM events WHERE id=$1", event_id)
        is_conf = ev_row and ev_row["module_slug"] == "conference"
        EVENT_ONLY_TYPES = {
            "30min_before",
            "2h_before_unreg", "2h_before_reg",
            "day_before_09_12_unreg", "day_before_09_12_reg",
            "event_live",
        }
        for tpl in DEFAULT_TEMPLATES:
            # event_live — только мероприятиям; 5min_before — только конференциям.
            if tpl["type"] == "event_live" and is_conf:
                continue
            if tpl["type"] == "5min_before" and not is_conf:
                continue
            if not is_conf and tpl["type"] not in EVENT_ONLY_TYPES:
                continue
            if is_conf and tpl["type"].startswith("day_before_09_12"):
                continue  # для конф эту роль играет pre_conf
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
                   target_channel_ids,
                   created_at
            FROM broadcast_templates
            WHERE event_id = $1
            ORDER BY type, created_at
            """,
            event_id
        )

    # Дефолтная афиша события (если в шаблоне photo_url не задан клиентом):
    # лучшая из event_posters по приоритету square > horizontal > vertical.
    from app.services.message_builder import get_default_event_photo
    default_poster = await get_default_event_photo(db, event_id)
    result = []
    for r in rows:
        d = dict(r)
        if d["type"] in ("day_end", "day_live", "vip_offer") and not d["photo_url"] and default_poster:
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

    # Кастомные шаблоны используют custom_datetime (fire_at вычисляется в generate_schedules)
    is_custom = data.type == "custom"
    schedule_mode = "custom_datetime" if is_custom else None
    allow_custom_datetime = True if is_custom else None

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates
          (client_id, event_id, name, type, subject, text, photo_url, button_text, button_url,
           audience_include, audience_exclude, custom_day_ref, custom_time,
           schedule_mode, allow_custom_datetime, target_channel_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                COALESCE($10, 'all_event'), COALESCE($11, 'none'),
                $12, $13,
                COALESCE($14, schedule_mode), COALESCE($15, allow_custom_datetime), $16)
        RETURNING id, name, type, subject, text, photo_url, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  custom_day_ref, custom_time, target_channel_ids, created_at
        """,
        client_id, event_id, data.name, data.type, data.subject,
        data.text, data.photo_url, data.button_text, data.button_url,
        data.audience_include, data.audience_exclude,
        data.custom_day_ref, data.custom_time,
        schedule_mode, allow_custom_datetime,
        data.target_channel_ids,
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
            name = $1, type = $2, subject = $3, text = $4,
            photo_url = $5, button_text = $6, button_url = $7,
            schedule_mode = COALESCE($8, schedule_mode),
            offset_minutes = COALESCE($9, offset_minutes),
            audience_include = COALESCE($10, audience_include),
            audience_exclude = COALESCE($11, audience_exclude),
            allow_custom_datetime = COALESCE($12, allow_custom_datetime),
            intro_start_time = COALESCE($13, intro_start_time),
            intro_interval_min = COALESCE($14, intro_interval_min),
            intro_days_before = COALESCE($15, intro_days_before),
            custom_day_ref = COALESCE($16, custom_day_ref),
            custom_time = COALESCE($17, custom_time),
            target_channel_ids = COALESCE($18::int[], target_channel_ids),
            updated_at = NOW()
        WHERE id = $19 AND event_id = $20
        RETURNING id, name, type, subject, text, photo_url, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  intro_start_time, intro_interval_min, intro_days_before,
                  custom_day_ref, custom_time, target_channel_ids
        """,
        data.name, data.type, data.subject, data.text,
        data.photo_url, data.button_text, data.button_url,
        data.schedule_mode, data.offset_minutes,
        data.audience_include, data.audience_exclude, data.allow_custom_datetime,
        data.intro_start_time, data.intro_interval_min, data.intro_days_before,
        data.custom_day_ref, data.custom_time,
        data.target_channel_ids,
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
               bs.started_at, bs.finished_at,
               CASE WHEN bs.finished_at IS NOT NULL AND bs.started_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (bs.finished_at - bs.started_at))::int
                    ELSE NULL END as duration_seconds,
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = bs.id AND bl.status = 'failed') as recipients_failed,
               bt.name as template_name, bt.type as template_type,
               bt.schedule_mode,
               cs.title as session_title,
               cs.start_time, cs.end_time,
               CASE
                 WHEN bs.type = 'speaker_intro' THEN ci.name
                 ELSE c.name
               END as speaker_name,
               bs.session_id,
               bs.error_log
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        LEFT JOIN conf_sessions cs ON cs.id = bs.session_id AND bs.type != 'speaker_intro'
        LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
        LEFT JOIN collaborators c ON c.id = cse.speaker_id
        LEFT JOIN event_collaborators cse_intro ON cse_intro.id = bs.session_id AND bs.type = 'speaker_intro'
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
            # Флаг overdue: время прошло, но рассылка не активирована (черновик/ожидание)
            d["is_overdue"] = diff < 0
        else:
            d["seconds_until"] = None
            d["is_overdue"] = False
        if r["status"] == "running" and r.get("started_at"):
            started = r["started_at"]
            if started.tzinfo is None:
                started = started.replace(tzinfo=ZoneInfo("UTC"))
            d["seconds_running"] = max(0, int((now_utc - started).total_seconds()))
        else:
            d["seconds_running"] = None
        result.append(d)

    # Следующая ожидающая рассылка (pending или draft с временем)
    pending = [x for x in result if x["status"] in ("pending", "draft") and x.get("fire_at_local")]
    next_pending = pending[0] if pending else None

    return {
        "schedules": result,
        "next_pending": next_pending,
        "timezone": tz_str,
    }


@router.post("/schedules/generate", summary="Создать расписание из программы события")
async def generate_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """
    Создаёт записи broadcast_schedules:
    - speaker_intro: одна на всё событие, fire_at = NULL (нужна кастомная дата)
    - 5min_before:   только конференция — per session, за offset_minutes до старта сессии (МСК).
    - event_live:    только мероприятие — единственная за 5 мин до events.start_at.
    - gift:          за offset_minutes до окончания сессии (только конф)
    - 2h_before_unreg/reg: за 120 мин до первой сессии дня (конф) или events.start_at (меропр)
    - 30min_before:  за 30 мин до первой сессии дня (конф) или events.start_at (меропр)
    - day_live:      в момент старта дня (только конф)
    - day_end:       через offset после последней сессии дня (только конф)
    - day_before_09_12_unreg/reg: за день в 09:12 МСК до events.start_at (только меропр)
    Пропускает дубли. fire_at всегда в UTC (внутреннее представление).

    Возвращает 400 если у конференции нет программы (conf_days/conf_sessions),
    или у мероприятия не задан events.start_at.
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    # Тип события + дата старта (для мероприятий)
    ev_row = await db.fetchrow(
        "SELECT module_slug, start_at, end_at FROM events WHERE id=$1",
        event_id
    )
    is_conf = ev_row and ev_row["module_slug"] == "conference"
    event_start_at = ev_row["start_at"] if ev_row else None
    event_end_at = ev_row["end_at"] if ev_row else None

    templates = await db.fetch(
        """
        SELECT id, type, schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before,
               custom_day_ref, custom_time,
               text, photo_url, button_text, button_url,
               name
        FROM broadcast_templates WHERE event_id=$1
        """,
        event_id
    )
    # Для предустановленных типов — один шаблон на тип. Кастомные собираем отдельным списком.
    tmpl_map = {t["type"]: t for t in templates if t["type"] != "custom"}
    custom_tmpls = [t for t in templates if t["type"] == "custom"]

    if not tmpl_map and not custom_tmpls:
        raise HTTPException(status_code=400, detail="Сначала создайте шаблоны рассылок")

    # Валидация: для конференции нужна программа, для мероприятия — start_at.
    if is_conf:
        any_day = await db.fetchval(
            "SELECT 1 FROM conf_days WHERE event_id=$1 LIMIT 1", event_id
        )
        if not any_day:
            raise HTTPException(
                status_code=400,
                detail="У конференции нет программы — добавьте дни и сессии во вкладке «Программа»"
            )
    else:
        if not event_start_at:
            raise HTTPException(
                status_code=400,
                detail="У мероприятия не задана дата старта — заполните «Дата начала» во вкладке «Основное»"
            )

    sessions = await db.fetch(
        """
        SELECT cs.id, cs.start_time, cs.end_time, cs.title, cs.day,
               d.day_date
        FROM conf_sessions cs
        LEFT JOIN conf_days d ON d.event_id = cs.event_id AND d.day_number = cs.day
        WHERE cs.event_id = $1
          AND cs.start_time IS NOT NULL
        ORDER BY cs.day, cs.start_time
        """,
        event_id
    ) if is_conf else []

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
              (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
               snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
            VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11)
            """,
            event_id, session_id, tmpl["id"], t, fire_at,
            tmpl["audience_include"], tmpl["audience_exclude"],
            tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
        )
        created += 1

    # Получаем первый день конференции (нужен для pre_conf и speaker_intro)
    first_day = await db.fetchrow(
        "SELECT day_date FROM conf_days WHERE event_id=$1 ORDER BY day_number LIMIT 1",
        event_id
    )

    # ── pre_conf: одна запись — анонс знакомства со спикерами в 10:43 за день до старта ──
    if "pre_conf" in tmpl_map:
        tmpl = tmpl_map["pre_conf"]
        if first_day and first_day["day_date"]:
            from datetime import date as ddate
            tz_msk = ZoneInfo("Europe/Moscow")
            conf_date = first_day["day_date"]
            send_date = conf_date - timedelta(days=1)
            fire_at_pre_conf = datetime(send_date.year, send_date.month, send_date.day, 10, 43, 0, tzinfo=tz_msk)
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='pre_conf'",
                event_id
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                    VALUES ($1, NULL, $2, 'pre_conf', $3, 'draft', $4, $5, $6, $7, $8, $9)
                    """,
                    event_id, tmpl["id"], fire_at_pre_conf,
                    tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
                )
                created += 1
            else:
                skipped += 1
        else:
            # Нет даты дня — создаём без времени
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='pre_conf'",
                event_id
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                    VALUES ($1, NULL, $2, 'pre_conf', NULL, 'draft', $3, $4, $5, $6, $7, $8)
                    """,
                    event_id, tmpl["id"],
                    tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
                )
                created += 1
            else:
                skipped += 1

    # ── speaker_intro: одна запись на каждого спикера — начиная через 5 мин после pre_conf ──
    # pre_conf в 10:43 → первый speaker_intro в 10:48, далее каждые 15 минут
    if "speaker_intro" in tmpl_map:
        tmpl = tmpl_map["speaker_intro"]

        interval_min = tmpl["intro_interval_min"] or 15
        days_before = tmpl["intro_days_before"] or 1

        speakers_list = await db.fetch(
            """SELECT cse.id FROM event_collaborators cse
               WHERE cse.event_id=$1 AND cse.is_visible=true
               ORDER BY """ + collaborator_sort.order_by_sql("cse"),
            event_id
        )

        if first_day and first_day["day_date"] and speakers_list:
            tz_msk = ZoneInfo("Europe/Moscow")
            conf_date = first_day["day_date"]
            start_date = conf_date - timedelta(days=days_before)
            # Первый speaker_intro = 10:48 (10:43 + 5 мин после pre_conf)
            base_dt = datetime(start_date.year, start_date.month, start_date.day, 10, 48, 0, tzinfo=tz_msk)

            for i, sp in enumerate(speakers_list):
                fire_at = base_dt + timedelta(minutes=interval_min * i)
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
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                    VALUES ($1, $2, $3, 'speaker_intro', $4, 'draft', $5, $6, $7, $8, $9, $10)
                    """,
                    event_id, sp["id"], tmpl["id"], fire_at,
                    tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
                )
                created += 1
        else:
            # Нет дней или спикеров — создаём одну запись без времени
            exists = await db.fetchval(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='speaker_intro' AND session_id IS NULL",
                event_id
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                    VALUES ($1, NULL, $2, 'speaker_intro', NULL, 'draft', $3, $4, $5, $6, $7, $8)
                    """,
                    event_id, tmpl["id"], tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
                )
                created += 1
            else:
                skipped += 1

    # ── Группируем сессии по дням ──
    days: dict = {}
    for s in sessions:
        d = s["day"] or 1
        days.setdefault(d, []).append(s)

    # ── 5min_before и gift — по каждой сессии со спикером (только конф) ──
    sessions_with_speaker = await db.fetch(
        """
        SELECT cs.id, cs.start_time, cs.end_time, cs.day,
               d.day_date
        FROM conf_sessions cs
        LEFT JOIN conf_days d ON d.event_id = cs.event_id AND d.day_number = cs.day
        WHERE cs.event_id = $1
          AND cs.speaker_id IS NOT NULL
          AND cs.start_time IS NOT NULL
        ORDER BY cs.day, cs.start_time
        """,
        event_id
    ) if is_conf else []

    for s in sessions_with_speaker:
        s_start_utc = _msk_str_to_utc(s["day_date"], s["start_time"])
        s_end_utc   = _msk_str_to_utc(s["day_date"], s["end_time"])

        if "5min_before" in tmpl_map and s_start_utc:
            tmpl = tmpl_map["5min_before"]
            offset = tmpl["offset_minutes"] or 5
            await add_schedule(tmpl, s_start_utc - timedelta(minutes=offset), s["id"], "5min_before")

        if "gift" in tmpl_map and s_end_utc:
            tmpl = tmpl_map["gift"]
            offset = tmpl["offset_minutes"] or 5
            await add_schedule(tmpl, s_end_utc - timedelta(minutes=offset), s["id"], "gift")

    # ── day_* — по первой/последней сессии каждого дня (только конф) ──
    for day_num, day_sessions in days.items():
        first_session = day_sessions[0]
        last_session = day_sessions[-1]
        first_start_utc = _msk_str_to_utc(first_session.get("day_date"), first_session.get("start_time"))
        last_end_utc    = _msk_str_to_utc(last_session.get("day_date"),  last_session.get("end_time"))

        for ttype in ("2h_before_unreg", "2h_before_reg", "30min_before"):
            if ttype in tmpl_map and first_start_utc:
                tmpl = tmpl_map[ttype]
                offset = tmpl["offset_minutes"] or 30
                await add_schedule(tmpl, first_start_utc - timedelta(minutes=offset), None, ttype)

        if "day_live" in tmpl_map and first_start_utc:
            tmpl = tmpl_map["day_live"]
            offset = tmpl["offset_minutes"] or 5
            await add_schedule(tmpl, first_start_utc - timedelta(minutes=offset), None, "day_live")

        if "day_end" in tmpl_map and last_end_utc:
            tmpl = tmpl_map["day_end"]
            offset = tmpl["offset_minutes"] or 30
            await add_schedule(tmpl, last_end_utc + timedelta(minutes=offset), None, "day_end")

    # ── Расписания для НЕ-конференций (одна точка отсчёта = events.start_at) ──
    # Все «дневные» рассылки (2h, 30min, event_live, day_before_09_12) — относительно start_at.
    # `5min_before` (за 5 мин до выступления спикера) не используется для мероприятий —
    # для них есть отдельный тип `event_live` (за 5 мин до старта эфира).
    if not is_conf and event_start_at:
        # event_start_at в БД хранится как TIMESTAMPTZ — приводим к UTC
        if event_start_at.tzinfo is None:
            event_start_utc = event_start_at.replace(tzinfo=ZoneInfo("UTC"))
        else:
            event_start_utc = event_start_at.astimezone(ZoneInfo("UTC"))

        # 2h, 30min, event_live — прямой offset до start_at (минуты)
        for ttype, default_off in (
            ("2h_before_unreg", 120),
            ("2h_before_reg", 120),
            ("30min_before", 30),
            ("event_live", 5),
        ):
            if ttype in tmpl_map:
                tmpl = tmpl_map[ttype]
                offset = tmpl["offset_minutes"] or default_off
                fire_at = event_start_utc - timedelta(minutes=offset)
                await add_schedule(tmpl, fire_at, None, ttype)

        # day_before_09_12_*: за день до start_at в 09:12 МСК
        tz_msk = ZoneInfo("Europe/Moscow")
        start_msk = event_start_utc.astimezone(tz_msk)
        day_before = start_msk.date() - timedelta(days=1)
        fire_at_09_12_msk = datetime(day_before.year, day_before.month, day_before.day, 9, 12, 0, tzinfo=tz_msk)
        fire_at_09_12_utc = fire_at_09_12_msk.astimezone(ZoneInfo("UTC"))
        for ttype in ("day_before_09_12_unreg", "day_before_09_12_reg"):
            if ttype in tmpl_map:
                await add_schedule(tmpl_map[ttype], fire_at_09_12_utc, None, ttype)

    # ── vip_offer: одна запись на событие с fire_at=NULL (пользователь сам задаёт время) ──
    if "vip_offer" in tmpl_map:
        tmpl = tmpl_map["vip_offer"]
        exists = await db.fetchval(
            "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='vip_offer' AND session_id IS NULL",
            event_id
        )
        if not exists:
            await db.execute(
                """
                INSERT INTO broadcast_schedules
                  (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                VALUES ($1, NULL, $2, 'vip_offer', NULL, 'draft', $3, $4, $5, $6, $7, $8)
                """,
                event_id, tmpl["id"], tmpl["audience_include"], tmpl["audience_exclude"],
                tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
            )
            created += 1
        else:
            skipped += 1

    # ── Кастомные шаблоны: fire_at = день_конфы(по custom_day_ref) + custom_time в таймзоне клиента ──
    if custom_tmpls:
        client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
        tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
        tz = ZoneInfo(tz_str)

        conf_days_list = await db.fetch(
            "SELECT day_number, day_date FROM conf_days WHERE event_id=$1 ORDER BY day_number",
            event_id
        )
        first_day_row = conf_days_list[0] if conf_days_list else None
        last_day_row = conf_days_list[-1] if conf_days_list else None
        days_by_num = {d["day_number"]: d["day_date"] for d in conf_days_list}

        for tmpl in custom_tmpls:
            ref = (tmpl["custom_day_ref"] or "").strip()
            tm = (tmpl["custom_time"] or "").strip()
            if not ref or not tm:
                skipped += 1
                continue
            try:
                hh, mm = tm.split(":")
                hh, mm = int(hh), int(mm)
            except Exception:
                skipped += 1
                continue

            target_date = None
            if ref.startswith("before_"):
                n = int(ref.split("_", 1)[1])
                if first_day_row and first_day_row["day_date"]:
                    target_date = first_day_row["day_date"] - timedelta(days=n)
            elif ref.startswith("day_"):
                n = int(ref.split("_", 1)[1])
                target_date = days_by_num.get(n)
            elif ref.startswith("after_"):
                n = int(ref.split("_", 1)[1])
                if last_day_row and last_day_row["day_date"]:
                    target_date = last_day_row["day_date"] + timedelta(days=n)

            if not target_date:
                skipped += 1
                continue

            fire_at = datetime(
                target_date.year, target_date.month, target_date.day, hh, mm, 0, tzinfo=tz
            )

            exists = await db.fetchval(
                """SELECT 1 FROM broadcast_schedules
                   WHERE event_id=$1 AND template_id=$2 AND type='custom'""",
                event_id, tmpl["id"]
            )
            if exists:
                skipped += 1
                continue
            await db.execute(
                """
                INSERT INTO broadcast_schedules
                  (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                VALUES ($1, NULL, $2, 'custom', $3, 'draft', $4, $5, $6, $7, $8, $9)
                """,
                event_id, tmpl["id"], fire_at,
                tmpl["audience_include"], tmpl["audience_exclude"],
                tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
            )
            created += 1

    return {"ok": True, "created": created, "skipped": skipped}


class SetFireAtRequest(BaseModel):
    fire_at: str
    is_test: bool = False
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None


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

    aud_include = data.audience_include
    aud_exclude = data.audience_exclude
    if aud_include and aud_exclude:
        row = await db.fetchrow(
            """UPDATE broadcast_schedules
               SET fire_at=$1, is_test=$2, audience_include=$3, audience_exclude=$4, status='draft'
               WHERE id=$5 AND event_id=$6
               RETURNING id, fire_at, is_test, audience_include, audience_exclude, status""",
            dt_utc, data.is_test, aud_include, aud_exclude, schedule_id, event_id
        )
    else:
        row = await db.fetchrow(
            """UPDATE broadcast_schedules
               SET fire_at=$1, is_test=$2, status='draft'
               WHERE id=$3 AND event_id=$4
               RETURNING id, fire_at, is_test, audience_include, audience_exclude, status""",
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
    session_id: Optional[int] = None
    day: Optional[int] = None
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
        "SELECT id, type, audience_include, audience_exclude, text, photo_url, button_text, button_url FROM broadcast_templates WHERE id=$1 AND event_id=$2",
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
          (event_id, template_id, type, session_id, fire_at, status, is_test, audience_include, audience_exclude,
           snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
        VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, type, fire_at, status, is_test, audience_include, audience_exclude
        """,
        event_id, tpl["id"], tpl["type"], data.session_id, dt_utc, data.is_test, aud_include, aud_exclude,
        tpl["text"], tpl["photo_url"], tpl["button_text"], tpl["button_url"]
    )
    return dict(row)


# ─── Произвольная рассылка (без шаблона) ─────────────────────────────────

class ButtonItem(BaseModel):
    text: str
    url: str


class AddCustomRequest(BaseModel):
    fire_at: str
    text: str
    photo_url: Optional[str] = None
    buttons: List[ButtonItem] = []
    is_test: bool = False
    audience_include: str = "all_event"
    audience_exclude: str = "none"


def _parse_fire_at(s: str, tz: ZoneInfo) -> datetime:
    dt_naive = datetime.fromisoformat(s)
    if dt_naive.tzinfo is None:
        dt_aware = dt_naive.replace(tzinfo=tz)
    else:
        dt_aware = dt_naive
    return dt_aware.astimezone(ZoneInfo("UTC"))


def _validate_custom_item(item: dict) -> list:
    """Возвращает список ошибок (пустой — всё ок)."""
    from app.api.broadcasts_general import validate_telegram_html, validate_button_pair
    errors = []
    if not item.get("fire_at"):
        errors.append("не указано время (fire_at)")
    text = (item.get("text") or "").strip()
    if not text:
        errors.append("пустой текст")
    else:
        for e in validate_telegram_html(text):
            errors.append(f"HTML: {e}")
    btns = item.get("buttons") or []
    if len(btns) > 3:
        errors.append(f"кнопок {len(btns)}, максимум 3")
    for i, b in enumerate(btns, 1):
        if not isinstance(b, dict):
            errors.append(f"кнопка #{i}: некорректный формат")
            continue
        for e in validate_button_pair(b.get("text"), b.get("url")):
            errors.append(f"кнопка #{i}: {e}")
    return errors


@router.post("/schedules/add-custom", summary="Добавить произвольную рассылку (без шаблона)")
async def add_custom_schedule(
    event_id: int,
    data: AddCustomRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    errors = _validate_custom_item(data.model_dump())
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))

    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
    tz = ZoneInfo(tz_str)

    try:
        dt_utc = _parse_fire_at(data.fire_at, tz)
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат даты")

    buttons_json = [{"text": b.text.strip(), "url": b.url.strip()} for b in data.buttons if b.text.strip() and b.url.strip()]

    import json as _json
    row = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, template_id, type, session_id, fire_at, status, is_test,
           audience_include, audience_exclude,
           snapshot_text, snapshot_photo, snapshot_buttons)
        VALUES ($1, NULL, 'custom', NULL, $2, 'pending', $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING id, type, fire_at, status, is_test
        """,
        event_id, dt_utc, data.is_test, data.audience_include, data.audience_exclude,
        data.text, data.photo_url, _json.dumps(buttons_json)
    )
    return dict(row)


class BulkItem(BaseModel):
    fire_at: str
    text: str
    photo_url: Optional[str] = None
    buttons: List[ButtonItem] = []


class BulkAddRequest(BaseModel):
    items: List[BulkItem]
    is_test: bool = False
    audience_include: str = "all_event"
    audience_exclude: str = "none"
    dry_run: bool = False   # только валидация без записи


@router.post("/schedules/bulk-add", summary="Пакетное добавление произвольных рассылок")
async def bulk_add_schedules(
    event_id: int,
    data: BulkAddRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
    tz = ZoneInfo(tz_str)

    # 1) Валидация всех записей
    errors_by_idx = []
    parsed = []
    for idx, it in enumerate(data.items, 1):
        item_d = it.model_dump()
        errs = _validate_custom_item(item_d)
        dt_utc = None
        if not errs:
            try:
                dt_utc = _parse_fire_at(it.fire_at, tz)
            except Exception:
                errs.append("неверный формат даты")
        if errs:
            errors_by_idx.append({"index": idx, "errors": errs})
        parsed.append({
            "index": idx,
            "dt_utc": dt_utc,
            "text": it.text,
            "photo_url": it.photo_url,
            "buttons": [{"text": b.text.strip(), "url": b.url.strip()} for b in it.buttons if b.text.strip() and b.url.strip()],
        })

    if errors_by_idx:
        return {"ok": False, "errors": errors_by_idx, "total": len(data.items)}
    if data.dry_run:
        return {"ok": True, "errors": [], "total": len(data.items), "dry_run": True}

    # 2) Вставка (всё или ничего — транзакция)
    import json as _json
    created_ids = []
    async with db.transaction():
        for p in parsed:
            row = await db.fetchrow(
                """
                INSERT INTO broadcast_schedules
                  (event_id, template_id, type, session_id, fire_at, status, is_test,
                   audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_buttons)
                VALUES ($1, NULL, 'custom', NULL, $2, 'pending', $3, $4, $5, $6, $7, $8::jsonb)
                RETURNING id
                """,
                event_id, p["dt_utc"], data.is_test, data.audience_include, data.audience_exclude,
                p["text"], p["photo_url"], _json.dumps(p["buttons"])
            )
            created_ids.append(row["id"])
    return {"ok": True, "errors": [], "created": len(created_ids), "ids": created_ids}


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


@router.post("/schedules/{schedule_id}/force-reset", summary="Аварийный сброс зависшей рассылки в pending")
async def force_reset_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    row = await db.fetchrow(
        "SELECT status, started_at FROM broadcast_schedules WHERE id=$1 AND event_id=$2",
        schedule_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Не найдено")
    if row["status"] != "running":
        raise HTTPException(status_code=400, detail=f"Рассылка не в статусе running (сейчас: {row['status']})")
    await db.execute(
        "UPDATE broadcast_schedules SET status='pending', started_at=NULL WHERE id=$1",
        schedule_id
    )
    return {"ok": True, "message": "Рассылка сброшена в pending — Celery подхватит её на следующей минуте"}


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
        """UPDATE broadcast_schedules SET status='cancelled', finished_at=COALESCE(finished_at, NOW())
           WHERE id=$1 AND event_id=$2 AND status IN ('pending','draft','running')""",
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
           (event_id, template_id, session_id, type, audience_include, audience_exclude,
            audience_type, fire_at, status, is_test,
            snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11,$12,$13)
           RETURNING id""",
        row["event_id"], row["template_id"], row["session_id"], row["type"],
        row["audience_include"], row["audience_exclude"], row["audience_type"],
        row["fire_at"], row["is_test"],
        row["snapshot_text"], row["snapshot_photo"], row["snapshot_btn_text"], row["snapshot_btn_url"]
    )
    return {"ok": True, "id": new_id}


@router.get("/schedules/{schedule_id}/log", summary="Лог получателей рассылки")
async def get_schedule_log(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await db.fetch(
        """
        SELECT bl.id AS broadcast_log_id,
               bl.status, bl.error, bl.sent_at,
               pu.first_name, pu.last_name, pu.username, pu.platform_user_id as tg_id,
               pu.platform_slug AS user_platform,
               bl.channel_id, ch.handle AS channel_handle, ch.display_name AS channel_name,
               ch.platform_slug AS channel_platform,
               (SELECT COUNT(*) FROM email_open_log eo  WHERE eo.broadcast_log_id = bl.id) AS email_opens,
               (SELECT COUNT(*) FROM email_click_log ec WHERE ec.broadcast_log_id = bl.id) AS email_clicks
        FROM broadcast_log bl
        JOIN platform_users pu ON pu.id = bl.platform_user_id
        LEFT JOIN channels ch ON ch.id = bl.channel_id
        WHERE bl.schedule_id = $1
        ORDER BY bl.sent_at
        """,
        schedule_id
    )
    return {"log": [dict(r) for r in rows]}


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

    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")

    snap = None
    if tpl_type == "custom":
        snap_buttons = schedule.get("snapshot_buttons")
        if isinstance(snap_buttons, str):
            try:
                import json as _json
                snap_buttons = _json.loads(snap_buttons)
            except Exception:
                snap_buttons = []
        snap = {
            "text": schedule.get("snapshot_text") or "",
            "photo": schedule.get("snapshot_photo"),
            "buttons": snap_buttons or [],
        }

    content = await build_message_content(
        conn=db,
        tpl_type=tpl_type,
        tmpl_text=schedule["tmpl_text"] or "",
        photo_url=schedule["tmpl_photo"],
        btn_text=schedule["tmpl_btn_text"],
        btn_url=schedule["tmpl_btn_url"] or "",
        event_id=event_id,
        session_id=schedule.get("session_id"),
        fire_at=schedule["fire_at"],
        tz=tz,
        template_id=schedule.get("template_id"),
        snapshot=snap,
    )

    return {
        "text": content["text"],
        "photo": content["photo"],
        "button_text": content.get("button_text"),
        "button_url": content.get("button_url"),
        "buttons": content.get("buttons") or [],
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
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    tpl = await db.fetchrow(
        "SELECT * FROM broadcast_templates WHERE id=$1 AND event_id=$2", template_id, event_id
    )
    if not tpl:
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    client_row = await db.fetchrow(
        "SELECT test_telegram_ids, test_vk_ids, test_max_ids, timezone FROM clients WHERE id=$1",
        client_id
    )
    from app.services.channels import get_client_telegram_token
    bot_token = await get_client_telegram_token(client_id, db)
    test_tg_ids = client_row["test_telegram_ids"] or []
    test_vk_ids = client_row["test_vk_ids"] or []
    test_max_ids = client_row["test_max_ids"] or []
    if not (test_tg_ids or test_vk_ids or test_max_ids):
        raise HTTPException(
            status_code=400,
            detail="Тестовые ID не заданы. Откройте Настройки → Технические → «Тестовые рассылки»."
        )
    if test_tg_ids and not bot_token:
        # У клиента есть тестовые TG ID, но TG-бот не подключён — это
        # ошибка конфигурации; не молчим, чтобы не казалось будто всё ОК.
        raise HTTPException(status_code=400, detail="Тестовые Telegram ID заданы, но токен бота не задан в настройках (channels)")
    tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")

    # MAX-токен — приоритет клиентский, fallback системный
    from app.config import settings as _settings
    client_max_token = await db.fetchval(
        """SELECT ch.bot_token
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'max' AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            LIMIT 1""",
        client_id,
    )
    max_token = client_max_token or _settings.max_system_bot_token

    async def _send_one_content(http, content: dict):
        """Шлёт `content` (text/photo/button_text/button_url) во все тестовые
        ID всех включённых платформ. Возвращает список результатов
        [{platform, chat_id, ok, error}, ...]."""
        out: list[dict] = []
        text = content.get("text") or ""
        photo = content.get("photo")
        btn_text = content.get("button_text")
        btn_url = content.get("button_url")

        # === Telegram ===
        if test_tg_ids and bot_token:
            for chat_id in [str(t) for t in test_tg_ids]:
                ok, err = await send_telegram_message(
                    http, bot_token, chat_id, text, photo, btn_text, btn_url
                )
                out.append({"platform": "telegram", "chat_id": chat_id, "ok": ok, "error": err})

        # === VK === (стрип HTML делает сам vk_api.send_message)
        if test_vk_ids:
            from app.services.vk_api import (
                send_message as vk_send,
                tg_inline_to_vk_keyboard,
            )
            vk_keyboard = None
            if btn_text and btn_url:
                vk_keyboard = tg_inline_to_vk_keyboard([[{"text": btn_text, "url": btn_url}]])
            # Фото в превью: VK сам развернёт по URL в начале сообщения.
            vk_text = f"{photo}\n\n{text}".strip() if photo else text
            for vid in [str(t) for t in test_vk_ids]:
                try:
                    res = await vk_send(int(vid), vk_text, keyboard=vk_keyboard)
                    out.append({
                        "platform": "vk", "chat_id": vid,
                        "ok": bool(res), "error": None if res else "VK send returned None"
                    })
                except Exception as e:
                    out.append({"platform": "vk", "chat_id": vid, "ok": False, "error": str(e)})

        # === MAX === (стрип HTML — пока не делаем, MAX поддерживает HTML аналогично TG)
        if test_max_ids and max_token:
            from app.services.max_api import (
                send_message as max_send,
                tg_inline_to_max_keyboard,
            )
            max_buttons = None
            if btn_text and btn_url:
                max_buttons = tg_inline_to_max_keyboard([[{"text": btn_text, "url": btn_url}]])
            max_text = text
            if photo:
                max_text = f"{photo}\n\n{max_text}".strip()
            for mid in [str(t) for t in test_max_ids]:
                try:
                    res = await max_send(int(mid), max_text, token=max_token, buttons=max_buttons)
                    out.append({
                        "platform": "max", "chat_id": mid,
                        "ok": bool(res), "error": None if res else "MAX send returned None"
                    })
                except Exception as e:
                    out.append({"platform": "max", "chat_id": mid, "ok": False, "error": str(e)})
        elif test_max_ids and not max_token:
            for mid in [str(t) for t in test_max_ids]:
                out.append({"platform": "max", "chat_id": mid, "ok": False,
                            "error": "MAX-бот не подключён и системный токен не настроен"})

        return out

    SPEAKER_TYPES = ("gift", "speaker_intro", "5min_before")

    if tpl["type"] in SPEAKER_TYPES:
        # Для спикерских шаблонов — отправляем по одному разу на каждого спикера дня
        sessions = await db.fetch(
            """
            SELECT cs.id as session_id, c.name as speaker_name
            FROM conf_sessions cs
            JOIN event_collaborators cse ON cse.id = cs.speaker_id
            JOIN collaborators c ON c.id = cse.speaker_id
            WHERE cs.event_id=$1 AND cs.day=$2 AND cs.speaker_id IS NOT NULL
            ORDER BY cs.sort_order
            """,
            event_id, day
        )
        results = []
        async with httpx.AsyncClient(timeout=15) as http:
            for s in sessions:
                content = await build_message_content(
                    conn=db, tpl_type=tpl["type"],
                    tmpl_text=tpl["text"], photo_url=tpl["photo_url"],
                    btn_text=tpl["button_text"], btn_url=tpl["button_url"] or "",
                    event_id=event_id, session_id=s["session_id"],
                    fire_at=None, tz=tz,
                )
                speaker_results = await _send_one_content(http, content)
                results.append({"speaker": s["speaker_name"], "results": speaker_results})
        return {"ok": True, "sent": len(sessions), "details": results}

    else:
        # Для всех остальных (day_*, pre_conf и любых будущих) — одна отправка.
        # fire_at имитируем через первую сессию выбранного дня (МСК → UTC).
        first_session = await db.fetchrow(
            """SELECT cs.start_time, d.day_date
                 FROM conf_sessions cs
                 LEFT JOIN conf_days d ON d.event_id = cs.event_id AND d.day_number = cs.day
                WHERE cs.event_id=$1 AND cs.day=$2 AND cs.start_time IS NOT NULL
                ORDER BY cs.start_time LIMIT 1""",
            event_id, day
        )
        fake_fire_at = _msk_str_to_utc(first_session["day_date"], first_session["start_time"]) if first_session else None

        content = await build_message_content(
            conn=db, tpl_type=tpl["type"],
            tmpl_text=tpl["text"], photo_url=tpl["photo_url"],
            btn_text=tpl["button_text"], btn_url=tpl["button_url"] or "",
            event_id=event_id, session_id=None,
            fire_at=fake_fire_at, tz=tz,
            template_id=tpl["id"],
        )
        async with httpx.AsyncClient(timeout=15) as http:
            send_results = await _send_one_content(http, content)
        return {"ok": True, "sent": 1, "details": [{"speaker": tpl["name"], "results": send_results}]}


# ─────────────────────────────────────────
# Хелпер
# ─────────────────────────────────────────
async def _check_event(db, event_id: int, client_id: int):
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id=$1 AND client_id=$2", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
