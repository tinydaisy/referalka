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
    video_url: Optional[str] = None             # видео (Telegram — встроенный плеер)
    media_type: Optional[str] = None            # None | 'photo' | 'video'
    button_text: Optional[str] = None
    button_url: Optional[str] = None
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    custom_day_ref: Optional[str] = None        # 'before_1' | 'day_1' | 'after_1' для type='custom'
    custom_time: Optional[str] = None           # 'HH:MM'
    # Каналы для отправки: NULL/None = все каналы клиента (default), [] = никуда,
    # [N,M] = только эти channel_id. Унаследуется в schedules через generate_schedules.
    target_channel_ids: Optional[List[int]] = None
    # Слать ещё и в групповые чаты события (tg/vk/max_chat_id) — в ДОПОЛНЕНИЕ к базе.
    send_to_event_chats: Optional[bool] = None
    # Слать ещё и в общую базу чатов клиента (client_broadcast_chats, is_private=FALSE).
    send_to_client_chats: Optional[bool] = None
    # Слать ещё и в личные каналы клиента (client_broadcast_chats, is_private=TRUE).
    send_to_private_chats: Optional[bool] = None
    # Источник фото для speaker_intro/5min_before/expert_day: 'poster' (афиша) | 'photo' (фото коллаба).
    speaker_photo_mode: Optional[str] = None


class TemplateUpdate(BaseModel):
    name: str
    type: str
    subject: Optional[str] = None
    text: Optional[str] = None
    photo_url: Optional[str] = None
    video_url: Optional[str] = None
    media_type: Optional[str] = None
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
    send_to_event_chats: Optional[bool] = None
    send_to_client_chats: Optional[bool] = None
    send_to_private_chats: Optional[bool] = None
    # Роли коллабораторов для speaker_intro (NULL = все). Пустой массив [] = никто.
    intro_roles: Optional[List[str]] = None
    # Источник фото: 'poster' (афиша) | 'photo' (фото коллаба).
    speaker_photo_mode: Optional[str] = None


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
        # «Экспертный день» — анонс сессии вопросов-ответов с коллабом события.
        # Раскладывается по каждому выбранному коллабу (жюри/спикер/организатор),
        # ровно как speaker_intro, но со своим текстом и очередью.
        "name": "Экспертный день (вопросы эксперту)",
        "type": "expert_day",
        "subject": "🚨 [Экспертный день] Завтра {speaker_name} ответит на ваши вопросы!",
        "text": (
            "Завтра в {brand_name} на связи — {speaker_name}: {speaker_positioning}\n\n"
            "{speaker_ask_topics}\n\n\n"
            "<b>Как принять участие:</b>\n"
            "1️⃣ Напишите сейчас свой вопрос в чат: {event_chat_tg}\n"
            "2️⃣ Обязательно отметьте никнейм эксперта: {speaker_tg_username}\n"
            "3️⃣ Завтра с 10:00 до 12:00 по МСК {speaker_name} лично ответит в чате на ваши вопросы\n"
            "4️⃣ Будьте в это время в чате — чтобы задать уточняющие вопросы в моменте\n\n"
            "——\n"
            "<b>{speaker_name}:</b>\n"
            "{speaker_achievements}\n\n"
            "<b>Соц сети:</b>\n"
            "{speaker_socials}\n\n"
            "{speaker_material}\n\n"
            "——\n"
            "<b>‼️ Внимание! Экспертный день пройдёт в чате Телеграм!\n"
            "Пишите свои вопросы 👇</b>\n"
            "{event_chat_tg}"
        ),
        "photo_url": None,
        "button_text": "ЗАДАТЬ ВОПРОС В ЧАТЕ",
        "button_url": "{event_chat_tg}",
        "schedule_mode": "custom_datetime",
        "offset_minutes": 0,
        "audience_include": "all_client",
        "audience_exclude": "none",
        "allow_custom_datetime": True,
    },
    {
        "name": "За 2 часа (не зарегистрирован)",
        "type": "2h_before_unreg",
        # Текст для конференций/турниров — с программой дня ({day_program}).
        "text": (
            "<b>Уже через 2 часа стартует «{conf_title}»</b>\n\n"
            "🔗 {landing_url} \n\n"
            "Сегодня в программе:\n\n"
            "{day_date}\n\n"
            "{day_program}\n\n"
            "Нажимай на кнопку «Зарегистрироваться», чтобы попасть в вебинарную комнату.\n"
            "🔗 {landing_url}\n\n"
            "—\n"
            "При возникновении технических трудностей пишите — @forbs_service2"
        ),
        # Текст для мероприятий — без программы по дням (её нет), дата+время старта.
        "text_event": (
            "<b>Уже через 2 часа стартует «{conf_title}»</b>\n\n"
            "🗓 {day_datetime}\n\n"
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
        SELECT id, name, type, subject, text, photo_url, video_url, media_type, button_text, button_url,
               schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before,
               custom_day_ref, custom_time,
               target_channel_ids, send_to_event_chats, send_to_client_chats, send_to_private_chats, intro_roles,
               speaker_photo_mode,
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
        is_turnir = ev_row and ev_row["module_slug"] == "turnir"
        # Мероприятие = не конференция и не турнир (base/webinar/прочие без программы).
        is_plain_event = not is_conf and not is_turnir
        EVENT_ONLY_TYPES = {
            "30min_before",
            "2h_before_unreg", "2h_before_reg",
            "day_before_09_12_unreg", "day_before_09_12_reg",
            "event_live",
        }
        # Турнир получает (помимо общих) рассылку знакомства со спикерами и жюри
        # (speaker_intro) И «за 5 минут до выступления» (5min_before) — как конференция.
        TURNIR_EXTRA_TYPES = {"speaker_intro", "5min_before"}
        for tpl in DEFAULT_TEMPLATES:
            # expert_day не сидим автоматически — это разовый анонс «Экспертного дня»,
            # клиент добавляет его сам через «Добавить готовый шаблон» (пресеты).
            if tpl["type"] == "expert_day":
                continue
            # event_live — только мероприятиям; 5min_before — конференциям и турнирам.
            if tpl["type"] == "event_live" and (is_conf or is_turnir):
                continue
            if tpl["type"] == "5min_before" and not (is_conf or is_turnir):
                continue
            if not is_conf and tpl["type"] not in EVENT_ONLY_TYPES:
                # Турниру дополнительно разрешаем speaker_intro (знакомство со спикерами/жюри).
                if not (is_turnir and tpl["type"] in TURNIR_EXTRA_TYPES):
                    continue
            if is_conf and tpl["type"].startswith("day_before_09_12"):
                continue  # для конф эту роль играет pre_conf
            # Для мероприятий — альтернативный текст без программы по дням (text_event),
            # если он задан у шаблона. Конференции/турниры используют основной text.
            tpl_text = tpl["text_event"] if (is_plain_event and tpl.get("text_event")) else tpl["text"]
            # У турнира знакомство охватывает и жюри — отражаем это в названии шаблона.
            tpl_name = tpl["name"]
            if is_turnir and tpl["type"] == "speaker_intro":
                tpl_name = "Знакомство со спикерами и жюри"
            await db.execute(
                """
                INSERT INTO broadcast_templates
                  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
                   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                """,
                client_id, event_id, tpl_name, tpl["type"],
                tpl_text, tpl["photo_url"], tpl["button_text"], tpl["button_url"],
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
           schedule_mode, allow_custom_datetime, target_channel_ids,
           video_url, media_type, send_to_event_chats, send_to_client_chats, send_to_private_chats,
           speaker_photo_mode)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                COALESCE($10, 'all_event'), COALESCE($11, 'none'),
                $12, $13,
                COALESCE($14, schedule_mode), COALESCE($15, allow_custom_datetime), $16,
                $17, $18, COALESCE($19, FALSE), COALESCE($20, FALSE), COALESCE($21, FALSE),
                COALESCE($22, 'poster'))
        RETURNING id, name, type, subject, text, photo_url, video_url, media_type, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  custom_day_ref, custom_time, target_channel_ids, send_to_event_chats, send_to_client_chats,
                  send_to_private_chats, speaker_photo_mode, created_at
        """,
        client_id, event_id, data.name, data.type, data.subject,
        data.text, data.photo_url, data.button_text, data.button_url,
        data.audience_include, data.audience_exclude,
        data.custom_day_ref, data.custom_time,
        schedule_mode, allow_custom_datetime,
        data.target_channel_ids,
        data.video_url, data.media_type,
        data.send_to_event_chats, data.send_to_client_chats, data.send_to_private_chats,
        data.speaker_photo_mode,
    )
    return dict(row)


def _allowed_preset_types_for_event(is_conf: bool, is_turnir: bool, for_presets: bool = False) -> list[dict]:
    """Возвращает DEFAULT_TEMPLATES, отфильтрованные по типу события — те же
    правила, что в auto-seed списка шаблонов (list_templates).

    for_presets=True — режим «Добавить готовый шаблон вручную»: турниру
    дополнительно разрешаем спикерские анонсы (pre_conf, 5min_before), которых
    нет в авто-сиде, но которые клиент может захотеть добавить сам."""
    is_plain_event = not is_conf and not is_turnir
    EVENT_ONLY_TYPES = {
        "30min_before", "2h_before_unreg", "2h_before_reg",
        "day_before_09_12_unreg", "day_before_09_12_reg", "event_live",
    }
    # Турнир: знакомство (speaker_intro) + «за 5 мин до выступления» (5min_before).
    TURNIR_EXTRA_TYPES = {"speaker_intro", "5min_before"}
    # При ручном добавлении турнир тоже может взять анонс знакомства (pre_conf),
    # «подарок спикера после выступления» (gift) и «Экспертный день» (expert_day).
    if for_presets:
        TURNIR_EXTRA_TYPES = TURNIR_EXTRA_TYPES | {"pre_conf", "gift", "expert_day"}
    out = []
    for tpl in DEFAULT_TEMPLATES:
        # expert_day — только как пресет (не в авто-сиде), и для конф, и для турнира.
        if tpl["type"] == "expert_day" and not for_presets:
            continue
        if tpl["type"] == "event_live" and (is_conf or is_turnir):
            continue
        if tpl["type"] == "5min_before" and not (is_conf or is_turnir):
            continue
        if not is_conf and tpl["type"] not in EVENT_ONLY_TYPES:
            if not (is_turnir and tpl["type"] in TURNIR_EXTRA_TYPES):
                continue
        if is_conf and tpl["type"].startswith("day_before_09_12"):
            continue
        tpl_name = tpl["name"]
        if is_turnir and tpl["type"] == "speaker_intro":
            tpl_name = "Знакомство со спикерами и жюри"
        tpl_text = tpl["text_event"] if (is_plain_event and tpl.get("text_event")) else tpl["text"]
        out.append({**tpl, "name": tpl_name, "text": tpl_text})
    return out


# Типы, которых у события может быть несколько (произвольные продающие/анонсные).
# Их не «прячем» из пресетов, даже если один такой уже создан.
MULTI_INSTANCE_PRESET_TYPES = {"vip_offer", "custom", "expert_day"}


@router.get("/templates/presets", summary="Готовые шаблоны для добавления")
async def list_template_presets(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Список предустановленных шаблонов, доступных для события и ещё НЕ
    добавленных (чтобы по кнопке «Добавить шаблон» можно было выбрать готовый)."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    ev_row = await db.fetchrow("SELECT module_slug FROM events WHERE id=$1", event_id)
    is_conf = bool(ev_row and ev_row["module_slug"] == "conference")
    is_turnir = bool(ev_row and ev_row["module_slug"] == "turnir")

    existing_types = {r["type"] for r in await db.fetch(
        "SELECT DISTINCT type FROM broadcast_templates WHERE event_id=$1", event_id
    )}
    presets = []
    for tpl in _allowed_preset_types_for_event(is_conf, is_turnir, for_presets=True):
        # Уже существующий одиночный тип — не предлагаем повторно.
        if tpl["type"] in existing_types and tpl["type"] not in MULTI_INSTANCE_PRESET_TYPES:
            continue
        presets.append({
            "type": tpl["type"],
            "name": tpl["name"],
            "text": tpl["text"],
            "button_text": tpl.get("button_text"),
            "button_url": tpl.get("button_url"),
        })
    return {"presets": presets}


class PresetCreate(BaseModel):
    type: str


@router.post("/templates/from-preset", summary="Создать шаблон из готового")
async def create_template_from_preset(
    event_id: int,
    data: PresetCreate,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Создаёт шаблон по типу из DEFAULT_TEMPLATES с его дефолтным текстом/кнопкой."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    ev_row = await db.fetchrow("SELECT module_slug FROM events WHERE id=$1", event_id)
    is_conf = bool(ev_row and ev_row["module_slug"] == "conference")
    is_turnir = bool(ev_row and ev_row["module_slug"] == "turnir")

    tpl = next((t for t in _allowed_preset_types_for_event(is_conf, is_turnir, for_presets=True)
                if t["type"] == data.type), None)
    if not tpl:
        raise HTTPException(status_code=400, detail="Такой готовый шаблон недоступен для этого события")

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates
          (client_id, event_id, name, type, subject, text, photo_url, button_text, button_url,
           schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id, name, type, subject, text, photo_url, video_url, media_type, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  custom_day_ref, custom_time, target_channel_ids, created_at
        """,
        client_id, event_id, tpl["name"], tpl["type"], tpl.get("subject"),
        tpl["text"], tpl["photo_url"], tpl["button_text"], tpl["button_url"],
        tpl["schedule_mode"], tpl["offset_minutes"],
        tpl["audience_include"], tpl["audience_exclude"], tpl["allow_custom_datetime"],
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

    # ЗАЩИТА ОТ ПОТЕРИ ТЕКСТА: пустой text НИКОГДА не затирает уже сохранённый.
    # Причина — фронт иногда шлёт пустую строку (гонка редактора), и шаблон
    # обнулялся. Реальная очистка текста в ноль не нужна (для этого есть
    # удаление шаблона), поэтому пустой text просто игнорируем — остаётся старый.
    new_text = data.text
    if not (data.text and data.text.strip()):
        new_text = await db.fetchval(
            "SELECT text FROM broadcast_templates WHERE id=$1 AND event_id=$2",
            template_id, event_id,
        )

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
            video_url = $21, media_type = $22,
            send_to_event_chats = COALESCE($23, send_to_event_chats),
            intro_roles = COALESCE($24::text[], intro_roles),
            send_to_client_chats = COALESCE($25, send_to_client_chats),
            send_to_private_chats = COALESCE($26, send_to_private_chats),
            speaker_photo_mode = COALESCE($27, speaker_photo_mode),
            updated_at = NOW()
        WHERE id = $19 AND event_id = $20
        RETURNING id, name, type, subject, text, photo_url, video_url, media_type, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  intro_start_time, intro_interval_min, intro_days_before,
                  custom_day_ref, custom_time, target_channel_ids, send_to_event_chats,
                  send_to_client_chats, send_to_private_chats, intro_roles, speaker_photo_mode
        """,
        data.name, data.type, data.subject, new_text,
        data.photo_url, data.button_text, data.button_url,
        data.schedule_mode, data.offset_minutes,
        data.audience_include, data.audience_exclude, data.allow_custom_datetime,
        data.intro_start_time, data.intro_interval_min, data.intro_days_before,
        data.custom_day_ref, data.custom_time,
        data.target_channel_ids,
        template_id, event_id,
        data.video_url, data.media_type,
        data.send_to_event_chats,
        data.intro_roles,
        data.send_to_client_chats,
        data.send_to_private_chats,
        data.speaker_photo_mode,
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
               -- «Дошло» — источник истины broadcast_log (реальные доставки),
               -- а НЕ bs.recipients_sent (ненадёжный счётчик: перезаписывается при
               -- ретраях/доотправке и расходится с фактом). Fallback на
               -- recipients_sent только если detailed-лога ещё нет (старые записи).
               COALESCE(
                 (SELECT COUNT(*) FROM broadcast_log bl
                   WHERE bl.schedule_id = bs.id AND bl.status = 'sent'),
                 0
               ) AS log_sent,
               bs.recipients_sent, bs.is_test, bs.audience_include, bs.audience_exclude,
               bs.started_at, bs.finished_at,
               CASE WHEN bs.finished_at IS NOT NULL AND bs.started_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (bs.finished_at - bs.started_at))::int
                    ELSE NULL END as duration_seconds,
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = bs.id AND bl.status = 'failed') as recipients_failed,
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = bs.id AND bl.status = 'bounced') as recipients_bounced,
               bt.name as template_name, bt.type as template_type,
               bt.schedule_mode,
               cs.title as session_title,
               cs.start_time, cs.end_time,
               CASE
                 WHEN bs.type IN ('speaker_intro', 'expert_day') THEN ci.name
                 ELSE c.name
               END as speaker_name,
               bs.session_id,
               bs.error_log,
               -- snapshot-поля нужны фронту для правки произвольной (custom) рассылки
               bs.snapshot_text, bs.snapshot_subject, bs.snapshot_photo, bs.snapshot_video,
               bs.snapshot_media_type, bs.snapshot_buttons, bs.send_to_event_chats,
               bs.send_to_client_chats, bs.send_to_private_chats, bs.target_channel_ids,
               -- Эффективные каналы/флаги: schedule → иначе значения шаблона (как при отправке).
               COALESCE(bs.target_channel_ids, bt.target_channel_ids) AS eff_target_channel_ids,
               (bs.send_to_event_chats OR COALESCE(bt.send_to_event_chats, FALSE)) AS eff_send_to_event_chats,
               (bs.send_to_client_chats OR COALESCE(bt.send_to_client_chats, FALSE)) AS eff_send_to_client_chats,
               (bs.send_to_private_chats OR COALESCE(bt.send_to_private_chats, FALSE)) AS eff_send_to_private_chats
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        -- speaker_intro/expert_day: session_id = event_collaborators.id (спикер),
        -- у остальных session_id = conf_sessions.id (сессия программы).
        LEFT JOIN conf_sessions cs ON cs.id = bs.session_id AND bs.type NOT IN ('speaker_intro', 'expert_day')
        LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
        LEFT JOIN collaborators c ON c.id = cse.speaker_id
        LEFT JOIN event_collaborators cse_intro ON cse_intro.id = bs.session_id AND bs.type IN ('speaker_intro', 'expert_day')
        LEFT JOIN collaborators ci ON ci.id = cse_intro.speaker_id
        WHERE bs.event_id = $1
          -- Коллаб-событие: каждый организатор видит рассылки ПО СВОЕЙ базе —
          -- свои (client_id=я), общие авто-сгенерированные (client_id IS NULL),
          -- и адресованные мне копии на подтверждение. Чужие копии — скрыты.
          AND (bs.client_id IS NULL OR bs.client_id = $2)
        ORDER BY bs.fire_at NULLS LAST
        """,
        event_id, client_id
    )

    # Часовой пояс клиента для отображения
    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
    tz = ZoneInfo(tz_str)

    now_utc = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC"))
    result = []
    import json as _json_list
    for r in rows:
        d = dict(r)
        # snapshot_buttons приходит из jsonb строкой — парсим в список, чтобы
        # форма правки видела кнопки (Array.isArray на фронте).
        sb = d.get("snapshot_buttons")
        if isinstance(sb, str):
            try:
                d["snapshot_buttons"] = _json_list.loads(sb)
            except Exception:
                d["snapshot_buttons"] = []
        # «Дошло» в плитке = реальные доставки из broadcast_log (как в модалке
        # «Получатели»). recipients_sent оставляем только как fallback, если лога
        # ещё нет (log_sent=0, но счётчик что-то писал — старые/тестовые записи).
        log_sent = d.pop("log_sent", 0) or 0
        if log_sent > 0:
            d["recipients_sent"] = log_sent
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


class GenerateRequest(BaseModel):
    # Если задан — формируем расписание ТОЛЬКО для шаблонов с этими id.
    # None/пусто = формировать по всем шаблонам (как было раньше).
    template_ids: Optional[List[int]] = None


@router.post("/schedules/generate", summary="Создать расписание из программы события")
async def generate_schedules(
    event_id: int,
    data: Optional[GenerateRequest] = None,
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
    is_turnir = ev_row and ev_row["module_slug"] == "turnir"
    event_start_at = ev_row["start_at"] if ev_row else None
    event_end_at = ev_row["end_at"] if ev_row else None

    # «Событие с программой по дням» — конференция или турнир, у которого
    # есть дни программы (conf_days). Тогда дневные рассылки (2h/30min) считаем
    # по первой сессии каждого дня, а не от единой events.start_at.
    has_conf_days = await db.fetchval(
        "SELECT 1 FROM conf_days WHERE event_id=$1 LIMIT 1", event_id
    )
    use_day_program = bool(is_conf or (is_turnir and has_conf_days))

    templates = await db.fetch(
        """
        SELECT id, type, schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before,
               custom_day_ref, custom_time,
               text, photo_url, button_text, button_url,
               name, send_to_event_chats, send_to_client_chats, send_to_private_chats, intro_roles
        FROM broadcast_templates WHERE event_id=$1
        """,
        event_id
    )
    # Фильтр по выбранным галочками шаблонам (если передан template_ids).
    only_ids = set(data.template_ids) if (data and data.template_ids is not None) else None
    if only_ids is not None:
        templates = [t for t in templates if t["id"] in only_ids]

    # Для предустановленных типов — один шаблон на тип. Кастомные и expert_day
    # (их может быть несколько на событие) собираем отдельными списками.
    tmpl_map = {t["type"]: t for t in templates if t["type"] not in ("custom", "expert_day")}
    custom_tmpls = [t for t in templates if t["type"] == "custom"]
    expert_day_tmpls = [t for t in templates if t["type"] == "expert_day"]

    if not tmpl_map and not custom_tmpls and not expert_day_tmpls:
        raise HTTPException(status_code=400, detail="Сначала создайте шаблоны рассылок" if only_ids is None else "Не выбрано ни одного шаблона")

    # Валидация: для события с программой по дням нужна программа (дни + сессии),
    # для обычного мероприятия — start_at.
    if use_day_program:
        any_session = await db.fetchval(
            "SELECT 1 FROM conf_sessions WHERE event_id=$1 AND start_time IS NOT NULL LIMIT 1",
            event_id
        )
        if not any_session:
            raise HTTPException(
                status_code=400,
                detail="В программе нет сессий со временем — добавьте сессии во вкладке «Программа»"
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
    ) if use_day_program else []

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

    # ── Общий fanout «одна запись на каждого выбранного коллаба» ──
    # Используется и для speaker_intro (знакомство), и для expert_day (Экспертный
    # день). Раскладывает шаблон по каждому коллабу события с учётом фильтра ролей
    # (intro_roles), начиная через 5 мин после pre_conf (10:48), далее с интервалом.
    async def _fanout_collaborator_intro(tmpl, per_template_dedup=False):
        nonlocal created, skipped
        b_type = tmpl["type"]
        interval_min = tmpl["intro_interval_min"] or 15
        days_before = tmpl["intro_days_before"] or 1

        # Фильтр по ролям: NULL = все роли; непустой список = только эти роли;
        # пустой список [] = ни одной роли (рассылку не формируем).
        intro_roles = tmpl.get("intro_roles")
        if intro_roles is not None and len(intro_roles) == 0:
            speakers_list = []
        elif intro_roles:
            speakers_list = await db.fetch(
                """SELECT cse.id FROM event_collaborators cse
                   WHERE cse.event_id=$1 AND cse.is_visible=true
                     AND cse.role = ANY($2::text[])
                   ORDER BY """ + collaborator_sort.order_by_sql("cse"),
                event_id, intro_roles
            )
        else:
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
            # Первый = 10:48 (10:43 + 5 мин после pre_conf), далее +interval.
            base_dt = datetime(start_date.year, start_date.month, start_date.day, 10, 48, 0, tzinfo=tz_msk)

            for i, sp in enumerate(speakers_list):
                fire_at = base_dt + timedelta(minutes=interval_min * i)
                # expert_day может быть несколько шаблонов на событие — дедупим ещё
                # и по template_id, чтобы разные «Экспертные дни» не схлопывались.
                if per_template_dedup:
                    exists = await db.fetchval(
                        """SELECT 1 FROM broadcast_schedules
                           WHERE event_id=$1 AND type=$2 AND session_id=$3 AND template_id=$4""",
                        event_id, b_type, sp["id"], tmpl["id"]
                    )
                else:
                    exists = await db.fetchval(
                        """SELECT 1 FROM broadcast_schedules
                           WHERE event_id=$1 AND type=$2 AND session_id=$3""",
                        event_id, b_type, sp["id"]
                    )
                if exists:
                    skipped += 1
                    continue
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                    VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11)
                    """,
                    event_id, sp["id"], tmpl["id"], b_type, fire_at,
                    tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
                )
                created += 1
        else:
            # Нет дней или коллабов — создаём одну запись без времени.
            if per_template_dedup:
                exists = await db.fetchval(
                    "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type=$2 AND session_id IS NULL AND template_id=$3",
                    event_id, b_type, tmpl["id"]
                )
            else:
                exists = await db.fetchval(
                    "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type=$2 AND session_id IS NULL",
                    event_id, b_type
                )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
                    VALUES ($1, NULL, $2, $3, NULL, 'draft', $4, $5, $6, $7, $8, $9)
                    """,
                    event_id, tmpl["id"], b_type, tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url")
                )
                created += 1
            else:
                skipped += 1

    # ── speaker_intro: одна запись на каждого спикера — начиная через 5 мин после pre_conf ──
    if "speaker_intro" in tmpl_map:
        await _fanout_collaborator_intro(tmpl_map["speaker_intro"])

    # ── expert_day: «Экспертный день» — одна запись на каждого выбранного коллаба.
    # Шаблонов может быть несколько (разные эксперты/дни) — дедупим по template_id.
    for _ed_tmpl in expert_day_tmpls:
        await _fanout_collaborator_intro(_ed_tmpl, per_template_dedup=True)

    # ── Группируем сессии по дням ──
    days: dict = {}
    for s in sessions:
        d = s["day"] or 1
        days.setdefault(d, []).append(s)

    # ── 5min_before и gift — по каждой сессии со спикером (конференция ИЛИ
    #    турнир с программой по дням). Раньше было только is_conf — из-за чего
    #    у турнира эти шаблоны не генерировали расписание. ──
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
    ) if use_day_program else []

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

    # ── event_live + day_before_09_12 для события с программой (турнир) ──
    # У турнира эти шаблоны засеяны как у мероприятия, но точка отсчёта = первая
    # сессия ПЕРВОГО дня программы (а не events.start_at, который не используется).
    if use_day_program and days:
        first_day_num = min(days.keys())
        first_day_sessions = days[first_day_num]
        prog_first_start_utc = _msk_str_to_utc(
            first_day_sessions[0].get("day_date"), first_day_sessions[0].get("start_time")
        )
        if prog_first_start_utc:
            if "event_live" in tmpl_map:
                tmpl = tmpl_map["event_live"]
                offset = tmpl["offset_minutes"] or 5
                await add_schedule(tmpl, prog_first_start_utc - timedelta(minutes=offset), None, "event_live")
            # day_before_09_12_*: за сутки до первой сессии, в 09:12 МСК
            tz_msk = ZoneInfo("Europe/Moscow")
            first_start_msk = prog_first_start_utc.astimezone(tz_msk)
            day_before = first_start_msk.date() - timedelta(days=1)
            fire_0912_utc = datetime(
                day_before.year, day_before.month, day_before.day, 9, 12, 0, tzinfo=tz_msk
            ).astimezone(ZoneInfo("UTC"))
            for ttype in ("day_before_09_12_unreg", "day_before_09_12_reg"):
                if ttype in tmpl_map:
                    await add_schedule(tmpl_map[ttype], fire_0912_utc, None, ttype)

    # ── Расписания для событий БЕЗ программы по дням (одна точка отсчёта = events.start_at) ──
    # Обычные мероприятия (и турнир без программы). Все «дневные» рассылки
    # (2h, 30min, event_live, day_before_09_12) — относительно start_at.
    # `5min_before` (за 5 мин до выступления спикера) не используется для мероприятий —
    # для них есть отдельный тип `event_live` (за 5 мин до старта эфира).
    if not use_day_program and event_start_at:
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

    # Проставляем флаг «слать в чаты события» во все созданные schedules,
    # унаследовав от их шаблона (snapshot на момент генерации).
    chat_tpl_ids = [t["id"] for t in templates if t.get("send_to_event_chats")]
    if chat_tpl_ids:
        await db.execute(
            """UPDATE broadcast_schedules
                 SET send_to_event_chats = TRUE
               WHERE event_id = $1 AND template_id = ANY($2::int[])""",
            event_id, chat_tpl_ids,
        )
    # То же для базы чатов клиента.
    client_tpl_ids = [t["id"] for t in templates if t.get("send_to_client_chats")]
    if client_tpl_ids:
        await db.execute(
            """UPDATE broadcast_schedules
                 SET send_to_client_chats = TRUE
               WHERE event_id = $1 AND template_id = ANY($2::int[])""",
            event_id, client_tpl_ids,
        )
    # То же для личных каналов.
    private_tpl_ids = [t["id"] for t in templates if t.get("send_to_private_chats")]
    if private_tpl_ids:
        await db.execute(
            """UPDATE broadcast_schedules
                 SET send_to_private_chats = TRUE
               WHERE event_id = $1 AND template_id = ANY($2::int[])""",
            event_id, private_tpl_ids,
        )

    return {"ok": True, "created": created, "skipped": skipped}


class SetFireAtRequest(BaseModel):
    fire_at: str
    is_test: bool = False
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    # Каналы для отправки: None = не менять; [] = никуда; [N,M] = только эти.
    target_channel_ids: Optional[List[int]] = None
    # Флаги «слать также в чаты» — None = не менять.
    send_to_event_chats: Optional[bool] = None
    send_to_client_chats: Optional[bool] = None
    send_to_private_chats: Optional[bool] = None


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

    # Динамический SET: базово fire_at/is_test/status, плюс опциональные поля,
    # которые пришли (None = не трогаем текущее значение в БД).
    set_parts = ["fire_at = $1", "is_test = $2", "status = 'draft'"]
    vals: list = [dt_utc, data.is_test]

    def _add(col: str, value):
        vals.append(value)
        set_parts.append(f"{col} = ${len(vals)}")

    if data.audience_include and data.audience_exclude:
        _add("audience_include", data.audience_include)
        _add("audience_exclude", data.audience_exclude)
    if data.target_channel_ids is not None:
        _add("target_channel_ids", data.target_channel_ids)
    if data.send_to_event_chats is not None:
        _add("send_to_event_chats", data.send_to_event_chats)
    if data.send_to_client_chats is not None:
        _add("send_to_client_chats", data.send_to_client_chats)
    if data.send_to_private_chats is not None:
        _add("send_to_private_chats", data.send_to_private_chats)

    vals.append(schedule_id)
    vals.append(event_id)
    row = await db.fetchrow(
        f"""UPDATE broadcast_schedules SET {', '.join(set_parts)}
             WHERE id = ${len(vals)-1} AND event_id = ${len(vals)}
             RETURNING id, fire_at, is_test, audience_include, audience_exclude,
                       target_channel_ids, send_to_event_chats, send_to_client_chats,
                       send_to_private_chats, status""",
        *vals
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
    # enqueue=True → сразу в очередь (status='pending'), иначе черновик (draft).
    enqueue: bool = False
    # Коллаб-событие: попросить соорганизаторов подтвердить рассылку по их базам.
    request_owner_confirm: bool = False


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
    # enqueue=True → сразу в очередь (pending, отправится по fire_at), иначе черновик (draft).
    new_status = "pending" if data.enqueue else "draft"
    if data.enqueue:
        _assert_fire_at_not_past(dt_utc)
    row = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, template_id, type, session_id, fire_at, status, is_test, audience_include, audience_exclude,
           snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
        VALUES ($1, $2, $3, $4, $5, $13, $6, $7, $8, $9, $10, $11, $12, $14)
        RETURNING id, type, fire_at, status, is_test, audience_include, audience_exclude
        """,
        event_id, tpl["id"], tpl["type"], data.session_id, dt_utc, data.is_test, aud_include, aud_exclude,
        tpl["text"], tpl["photo_url"], tpl["button_text"], tpl["button_url"], new_status, client_id
    )
    result = dict(row)
    if data.request_owner_confirm:
        from app.services.collab_broadcast import fanout_confirmations
        result["confirm_batch_id"] = await fanout_confirmations(db, event_id, client_id, [row["id"]])
    return result


# ─── Произвольная рассылка (без шаблона) ─────────────────────────────────

class ButtonItem(BaseModel):
    text: str
    url: str


class AddCustomRequest(BaseModel):
    fire_at: str
    text: str
    photo_url: Optional[str] = None
    video_url: Optional[str] = None
    media_type: Optional[str] = None
    buttons: List[ButtonItem] = []
    is_test: bool = False
    audience_include: str = "all_event"
    audience_exclude: str = "none"
    send_to_event_chats: bool = False
    send_to_client_chats: bool = False
    send_to_private_chats: bool = False
    # Каналы для отправки: None = все каналы клиента; [] = никуда; [N,M] = только эти.
    target_channel_ids: Optional[List[int]] = None
    # Коллаб-событие: попросить соорганизаторов подтвердить рассылку по их базам.
    request_owner_confirm: bool = False
    # Выбранный спикер/организатор/жюри (event_collaborators.id) — тогда работают
    # спикерские плейсхолдеры и подставляется его фото. None = обычное сообщение.
    speaker_ec_id: Optional[int] = None
    # Поставить сразу в очередь (pending) или оставить черновиком (draft).
    enqueue: bool = True


def _resolve_snapshot_media(photo_url: Optional[str], video_url: Optional[str],
                            media_type: Optional[str]) -> tuple:
    """(snapshot_photo, snapshot_video, snapshot_media_type) — см. broadcasts_general._resolve_media."""
    mt = (media_type or "").strip().lower() or None
    p = (photo_url or "").strip() or None
    v = (video_url or "").strip() or None
    if mt == "video" and v:
        return None, v, "video"
    if mt == "photo" and p:
        return p, None, "photo"
    if mt is None and v:
        return None, v, "video"
    if mt is None and p:
        return p, None, "photo"
    return None, None, None


def _parse_fire_at(s: str, tz: ZoneInfo) -> datetime:
    dt_naive = datetime.fromisoformat(s)
    if dt_naive.tzinfo is None:
        dt_aware = dt_naive.replace(tzinfo=tz)
    else:
        dt_aware = dt_naive
    return dt_aware.astimezone(ZoneInfo("UTC"))


_PAST_GRACE_MIN = 5


def _assert_fire_at_not_past(fire_at_utc: datetime) -> None:
    """Защита от ошибочной отправки: рассылку с датой в прошлом ставить в очередь нельзя
    (иначе Celery берёт fire_at <= NOW() и шлёт мгновенно). Люфт — под «отправить немедленно»."""
    now_utc = datetime.now(ZoneInfo("UTC"))
    if fire_at_utc < now_utc - timedelta(minutes=_PAST_GRACE_MIN):
        raise HTTPException(
            status_code=400,
            detail="Дата отправки уже прошла. Укажите будущее время — иначе рассылка ушла бы сразу.",
        )


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
    _assert_fire_at_not_past(dt_utc)

    buttons_json = [{"text": b.text.strip(), "url": b.url.strip()} for b in data.buttons if b.text.strip() and b.url.strip()]

    # Проверяем, что выбранный спикер принадлежит этому событию.
    speaker_ec_id = data.speaker_ec_id
    if speaker_ec_id:
        ok = await db.fetchval(
            "SELECT 1 FROM event_collaborators WHERE id=$1 AND event_id=$2",
            speaker_ec_id, event_id)
        if not ok:
            raise HTTPException(status_code=400, detail="Выбранный спикер не найден в этом событии")

    status_val = "pending" if data.enqueue else "draft"
    import json as _json
    snap_photo, snap_video, snap_mtype = _resolve_snapshot_media(data.photo_url, data.video_url, data.media_type)
    row = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, template_id, type, session_id, fire_at, status, is_test,
           audience_include, audience_exclude,
           snapshot_text, snapshot_photo, snapshot_buttons,
           snapshot_video, snapshot_media_type, send_to_event_chats, send_to_client_chats,
           send_to_private_chats, client_id, target_channel_ids)
        VALUES ($1, NULL, 'custom', $15, $2, $16, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $17)
        RETURNING id, type, fire_at, status, is_test
        """,
        event_id, dt_utc, data.is_test, data.audience_include, data.audience_exclude,
        data.text, snap_photo, _json.dumps(buttons_json), snap_video, snap_mtype,
        data.send_to_event_chats, data.send_to_client_chats, data.send_to_private_chats, client_id,
        speaker_ec_id, status_val, data.target_channel_ids
    )
    result = dict(row)
    # Коллаб-событие + галочка → копии соорганизаторам на подтверждение (по их базам).
    if data.request_owner_confirm:
        from app.services.collab_broadcast import fanout_confirmations
        batch = await fanout_confirmations(db, event_id, client_id, [row["id"]])
        result["confirm_batch_id"] = batch
    return result


@router.put("/schedules/{schedule_id}/custom", summary="Редактировать произвольную рассылку")
async def edit_custom_schedule(
    event_id: int,
    schedule_id: int,
    data: AddCustomRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Правка текста/фото/кнопок/времени/аудитории произвольной (type='custom')
    рассылки в очереди. Только пока не отправлена (draft/pending)."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    cur = await db.fetchrow(
        "SELECT type, status FROM broadcast_schedules WHERE id=$1 AND event_id=$2",
        schedule_id, event_id,
    )
    if not cur:
        raise HTTPException(status_code=404, detail="Рассылка не найдена")
    if cur["type"] != "custom":
        raise HTTPException(status_code=400, detail="Править можно только произвольную рассылку")
    if cur["status"] not in ("draft", "pending"):
        raise HTTPException(status_code=400, detail="Эту рассылку уже нельзя редактировать (отправлена/отменена)")

    errors = _validate_custom_item(data.model_dump())
    if errors:
        raise HTTPException(status_code=400, detail="; ".join(errors))

    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")
    try:
        dt_utc = _parse_fire_at(data.fire_at, tz)
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат даты")
    # Рассылка в очереди (pending) с датой в прошлом ушла бы мгновенно — запрещаем.
    if cur["status"] == "pending":
        _assert_fire_at_not_past(dt_utc)

    speaker_ec_id = data.speaker_ec_id
    if speaker_ec_id:
        ok = await db.fetchval(
            "SELECT 1 FROM event_collaborators WHERE id=$1 AND event_id=$2",
            speaker_ec_id, event_id)
        if not ok:
            raise HTTPException(status_code=400, detail="Выбранный спикер не найден в этом событии")

    import json as _json
    buttons_json = [{"text": b.text.strip(), "url": b.url.strip()} for b in data.buttons if b.text.strip() and b.url.strip()]
    snap_photo, snap_video, snap_mtype = _resolve_snapshot_media(data.photo_url, data.video_url, data.media_type)
    row = await db.fetchrow(
        """
        UPDATE broadcast_schedules SET
            fire_at = $1, is_test = $2,
            audience_include = $3, audience_exclude = $4,
            snapshot_text = $5, snapshot_photo = $6, snapshot_buttons = $7::jsonb,
            snapshot_video = $8, snapshot_media_type = $9,
            send_to_event_chats = $12, send_to_client_chats = $13, send_to_private_chats = $14,
            session_id = $15, target_channel_ids = $16
        WHERE id = $10 AND event_id = $11 AND type = 'custom'
        RETURNING id, type, fire_at, status, is_test
        """,
        dt_utc, data.is_test, data.audience_include, data.audience_exclude,
        data.text, snap_photo, _json.dumps(buttons_json), snap_video, snap_mtype,
        schedule_id, event_id, data.send_to_event_chats, data.send_to_client_chats,
        data.send_to_private_chats, speaker_ec_id, data.target_channel_ids,
    )
    return dict(row)


class BulkItem(BaseModel):
    fire_at: str
    text: str
    photo_url: Optional[str] = None
    video_url: Optional[str] = None
    media_type: Optional[str] = None
    buttons: List[ButtonItem] = []
    # Аудитория на КОНКРЕТНУЮ рассылку (сегмент). None = взять общие из запроса.
    audience_include: Optional[str] = None
    audience_exclude: Optional[str] = None
    send_to_event_chats: Optional[bool] = None
    send_to_client_chats: Optional[bool] = None
    send_to_private_chats: Optional[bool] = None


class BulkAddRequest(BaseModel):
    items: List[BulkItem]
    is_test: bool = False
    # Общая аудитория по умолчанию (если у item не задана своя).
    audience_include: str = "all_event"
    audience_exclude: str = "none"
    dry_run: bool = False   # только валидация без записи
    # enqueue=True → создать сразу в очередь (status='pending'), иначе черновики (draft).
    enqueue: bool = False
    # Коллаб-событие: попросить соорганизаторов подтвердить весь пакет (1 подтверждение).
    request_owner_confirm: bool = False


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
        if not errs and data.enqueue and dt_utc is not None:
            if dt_utc < datetime.now(ZoneInfo("UTC")) - timedelta(minutes=_PAST_GRACE_MIN):
                errs.append("дата уже прошла — рассылка ушла бы сразу; укажите будущее время")
        if errs:
            errors_by_idx.append({"index": idx, "errors": errs})
        sp, sv, smt = _resolve_snapshot_media(it.photo_url, it.video_url, it.media_type)
        parsed.append({
            "index": idx,
            "dt_utc": dt_utc,
            "text": it.text,
            "photo_url": sp,
            "video_url": sv,
            "media_type": smt,
            "buttons": [{"text": b.text.strip(), "url": b.url.strip()} for b in it.buttons if b.text.strip() and b.url.strip()],
            # Аудитория/чаты сегмента: своё у item → иначе общие из запроса.
            "audience_include": it.audience_include or data.audience_include,
            "audience_exclude": it.audience_exclude or data.audience_exclude,
            "send_to_event_chats": bool(it.send_to_event_chats),
            "send_to_client_chats": bool(it.send_to_client_chats),
            "send_to_private_chats": bool(it.send_to_private_chats),
        })

    if errors_by_idx:
        return {"ok": False, "errors": errors_by_idx, "total": len(data.items)}
    if data.dry_run:
        return {"ok": True, "errors": [], "total": len(data.items), "dry_run": True}

    # 2) Импорт фото по внешним ссылкам в R2 (Google Drive / облака → наш URL).
    #    Сбой фото НЕ роняет всю партию: рассылка создаётся без фото, проблема — в отчёт.
    from app.services.remote_media import import_remote_image_to_r2
    warnings = []
    for p in parsed:
        if p.get("photo_url"):
            try:
                p["photo_url"] = await import_remote_image_to_r2(client_id, p["photo_url"])
            except Exception as e:
                warnings.append({"index": p["index"], "message": f"фото не загрузилось — {e}. Рассылка создана без фото."})
                p["photo_url"] = None
                if p.get("media_type") == "photo":
                    p["media_type"] = None

    # 3) Вставка (всё или ничего — транзакция)
    #    enqueue=True → сразу в очередь (pending), иначе черновик (draft).
    import json as _json
    new_status = "pending" if data.enqueue else "draft"
    created_ids = []
    confirm_batch = None
    async with db.transaction():
        for p in parsed:
            row = await db.fetchrow(
                """
                INSERT INTO broadcast_schedules
                  (event_id, template_id, type, session_id, fire_at, status, is_test,
                   audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_buttons,
                   snapshot_video, snapshot_media_type,
                   send_to_event_chats, send_to_client_chats, send_to_private_chats, client_id)
                VALUES ($1, NULL, 'custom', NULL, $2, $13, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $15, $14)
                RETURNING id
                """,
                event_id, p["dt_utc"], data.is_test, p["audience_include"], p["audience_exclude"],
                p["text"], p["photo_url"], _json.dumps(p["buttons"]),
                p["video_url"], p["media_type"],
                p["send_to_event_chats"], p["send_to_client_chats"], new_status, client_id,
                p["send_to_private_chats"]
            )
            created_ids.append(row["id"])
        # Коллаб-событие + галочка → ОДИН пакет-подтверждение на весь bulk соорганизаторам.
        if data.request_owner_confirm and created_ids:
            from app.services.collab_broadcast import fanout_confirmations
            confirm_batch = await fanout_confirmations(db, event_id, client_id, created_ids)
    return {"ok": True, "errors": [], "created": len(created_ids), "ids": created_ids,
            "warnings": warnings, "confirm_batch_id": confirm_batch}


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

    # ⚠️ Защита от ошибочной массовой отправки: рассылки с датой в прошлом
    # ушли бы немедленно. Блокируем запуск, пока клиент не поправит дату.
    past_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='draft' "
        "AND fire_at IS NOT NULL AND fire_at < (NOW() - INTERVAL '5 minutes')",
        event_id
    )
    if past_fire and past_fire > 0:
        raise HTTPException(
            status_code=400,
            detail=f"У {past_fire} рассылок дата отправки уже прошла — они ушли бы сразу. "
                   "Исправьте дату (или удалите старые копии) перед запуском."
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

    past_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE id = ANY($1::int[]) AND event_id=$2 "
        "AND status='draft' AND fire_at IS NOT NULL AND fire_at < (NOW() - INTERVAL '5 minutes')",
        ids, event_id
    )
    if past_fire and past_fire > 0:
        raise HTTPException(
            status_code=400,
            detail=f"У {past_fire} выбранных рассылок дата уже прошла — они ушли бы сразу. Исправьте дату."
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


@router.post("/schedules/{schedule_id}/cancel", summary="Снять рассылку с очереди → черновик")
async def cancel_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """«Отменить» = снять из очереди и вернуть в ЧЕРНОВИК (не 'cancelled'), чтобы
    рассылку можно было запустить снова. Celery берёт только 'pending' —
    'draft' он не трогает, поэтому запись безопасно замирает как черновик."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    await db.execute(
        """UPDATE broadcast_schedules SET status='draft', finished_at=NULL, started_at=NULL, error_log=NULL
           WHERE id=$1 AND event_id=$2 AND status IN ('pending','draft','running','cancelled')""",
        schedule_id, event_id
    )
    return {"ok": True}


@router.post("/schedules/cancel-all", summary="Снять все pending рассылки с очереди → черновики")
async def cancel_all_schedules(
    event_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    count = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status IN ('pending','running')", event_id
    )
    await db.execute(
        """UPDATE broadcast_schedules SET status='draft', finished_at=NULL, started_at=NULL, error_log=NULL
             WHERE event_id=$1 AND status IN ('pending','running')""",
        event_id
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

    # ⚠️ Копия создаётся БЕЗ даты (fire_at=NULL), чтобы старая дата не утащила
    # рассылку в мгновенную отправку. Клиент указывает новую дату при запуске.
    new_id = await db.fetchval(
        """INSERT INTO broadcast_schedules
           (event_id, template_id, session_id, type, audience_include, audience_exclude,
            audience_type, fire_at, status, is_test,
            snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'draft',$8,$9,$10,$11,$12)
           RETURNING id""",
        row["event_id"], row["template_id"], row["session_id"], row["type"],
        row["audience_include"], row["audience_exclude"], row["audience_type"],
        row["is_test"],
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
               bt.video_url as tmpl_video, bt.media_type as tmpl_media_type,
               bt.button_text as tmpl_btn_text, bt.button_url as tmpl_btn_url,
               bt.type as tmpl_type, bt.speaker_photo_mode as tmpl_speaker_photo_mode,
               bt.subject as tmpl_subject
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
            "video": schedule.get("snapshot_video"),
            "media_type": schedule.get("snapshot_media_type"),
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
        video_url=schedule["tmpl_video"],
        media_type=schedule["tmpl_media_type"],
        speaker_photo_mode=schedule.get("tmpl_speaker_photo_mode") or "poster",
        subject=(schedule.get("snapshot_subject") or schedule.get("tmpl_subject")),
    )

    return {
        "text": content["text"],
        "subject": content.get("subject"),
        "photo": content["photo"],
        "video": content.get("video"),
        "media_type": content.get("media_type"),
        "button_text": content.get("button_text"),
        "button_url": content.get("button_url"),
        "buttons": content.get("buttons") or [],
        "template_type": tpl_type,
    }




# ─────────────────────────────────────────
# ТЕСТОВАЯ РАССЫЛКА
# ─────────────────────────────────────────

async def _load_test_targets(db, client_id: int):
    """Тестовые ID клиента + токены платформ. Кидает 400, если тестовых нет."""
    client_row = await db.fetchrow(
        "SELECT test_telegram_ids, test_vk_ids, test_max_ids, timezone FROM clients WHERE id=$1",
        client_id
    )
    from app.services.channels import get_client_telegram_token
    from app.config import settings as _settings
    bot_token = await get_client_telegram_token(client_id, db)
    test_tg_ids = client_row["test_telegram_ids"] or []
    test_vk_ids = client_row["test_vk_ids"] or []
    test_max_ids = client_row["test_max_ids"] or []
    if not (test_tg_ids or test_vk_ids or test_max_ids):
        raise HTTPException(status_code=400,
            detail="Тестовые ID не заданы. Откройте Настройки → Технические → «Тестовые рассылки».")
    if test_tg_ids and not bot_token:
        raise HTTPException(status_code=400,
            detail="Тестовые Telegram ID заданы, но токен бота не задан в настройках (Каналы).")
    client_max_token = await db.fetchval(
        """SELECT ch.bot_token FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id=$1 AND cc.is_active=TRUE AND ch.platform_slug='max'
              AND ch.is_system=FALSE AND ch.bot_token IS NOT NULL AND ch.bot_token <> '' LIMIT 1""",
        client_id)
    max_token = client_max_token or _settings.max_system_bot_token
    tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")
    return bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token, tz


async def _send_content_to_tests(content: dict, bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token):
    """Шлёт готовый content (text/photo/video/buttons) во все тестовые ID всех платформ."""
    text = content.get("text") or ""
    photo = content.get("photo")
    video = content.get("video")
    m_type = content.get("media_type")
    buttons = content.get("buttons") or []
    btn_text = content.get("button_text") or (buttons[0]["text"] if buttons else None)
    btn_url = content.get("button_url") or (buttons[0]["url"] if buttons else None)
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=20) as http:
        if test_tg_ids and bot_token:
            for chat_id in [str(t) for t in test_tg_ids]:
                ok, err = await send_telegram_message(
                    http, bot_token, chat_id, text, photo, btn_text, btn_url,
                    buttons=buttons or None,
                    video_url=video if m_type == "video" else None)
                out.append({"platform": "telegram", "chat_id": chat_id, "ok": ok, "error": err})
    if test_vk_ids:
        from app.services.vk_api import send_message as vk_send, tg_inline_to_vk_keyboard
        vk_keyboard = tg_inline_to_vk_keyboard([[{"text": btn_text, "url": btn_url}]]) if (btn_text and btn_url) else None
        vk_text = f"{photo}\n\n{text}".strip() if photo else text
        if m_type == "video" and video:
            vk_text = f"{vk_text}\n\n🎬 Видео: {video}".strip()
        for vid in [str(t) for t in test_vk_ids]:
            try:
                res = await vk_send(int(vid), vk_text, keyboard=vk_keyboard)
                out.append({"platform": "vk", "chat_id": vid, "ok": bool(res), "error": None if res else "VK send returned None"})
            except Exception as e:
                out.append({"platform": "vk", "chat_id": vid, "ok": False, "error": str(e)})
    if test_max_ids and max_token:
        from app.services.max_api import send_message as max_send, tg_inline_to_max_keyboard
        max_buttons = tg_inline_to_max_keyboard([[{"text": btn_text, "url": btn_url}]]) if (btn_text and btn_url) else None
        max_text = f"{photo}\n\n{text}".strip() if photo else text
        if m_type == "video" and video:
            max_text = f"{max_text}\n\n🎬 Видео: {video}".strip()
        for mid in [str(t) for t in test_max_ids]:
            try:
                res = await max_send(int(mid), max_text, token=max_token, buttons=max_buttons)
                out.append({"platform": "max", "chat_id": mid, "ok": bool(res), "error": None if res else "MAX send returned None"})
            except Exception as e:
                out.append({"platform": "max", "chat_id": mid, "ok": False, "error": str(e)})
    return out


class TestNowRequest(BaseModel):
    text: str
    photo_url: Optional[str] = None
    video_url: Optional[str] = None
    media_type: Optional[str] = None
    buttons: List[ButtonItem] = []
    speaker_ec_id: Optional[int] = None
    subject: Optional[str] = None


@router.post("/schedules/test-now", summary="Отправить тестовую рассылку немедленно (произвольный контент)")
async def test_send_now(
    event_id: int,
    data: TestNowRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Собирает сообщение как произвольную рассылку (с учётом выбранного спикера и
    его плейсхолдеров/{stream_url}) и шлёт СРАЗУ на тестовые ID клиента — без
    создания задачи в очереди."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    if not (data.text or "").strip():
        raise HTTPException(status_code=400, detail="Пустой текст")
    if data.speaker_ec_id:
        ok = await db.fetchval("SELECT 1 FROM event_collaborators WHERE id=$1 AND event_id=$2",
                               data.speaker_ec_id, event_id)
        if not ok:
            raise HTTPException(status_code=400, detail="Выбранный спикер не найден в этом событии")

    bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token, tz = await _load_test_targets(db, client_id)
    snap_photo, snap_video, snap_mtype = _resolve_snapshot_media(data.photo_url, data.video_url, data.media_type)
    snap = {
        "text": data.text,
        "photo": snap_photo,
        "video": snap_video,
        "media_type": snap_mtype,
        "buttons": [{"text": b.text.strip(), "url": b.url.strip()} for b in data.buttons if b.text.strip() and b.url.strip()],
    }
    content = await build_message_content(
        conn=db, tpl_type="custom", tmpl_text=data.text, photo_url=snap_photo,
        btn_text=None, btn_url="", event_id=event_id, session_id=data.speaker_ec_id,
        fire_at=None, tz=tz, snapshot=snap, video_url=snap_video, media_type=snap_mtype)
    results = await _send_content_to_tests(content, bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token)
    sent = sum(1 for r in results if r.get("ok"))
    return {"ok": True, "sent": sent, "total": len(results), "results": results}


@router.post("/schedules/{schedule_id}/test-now", summary="Тест существующей задачи немедленно")
async def test_existing_schedule_now(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Собирает сообщение существующей задачи В ТОЧНОСТИ как оно уйдёт (тот же
    build_message_content, что и превью: свежий шаблон + спикер + плейсхолдеры) и
    шлёт СРАЗУ на тестовые ID клиента. Работает для любого типа рассылки."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    schedule = await db.fetchrow(
        """
        SELECT bs.*, bt.text as tmpl_text, bt.photo_url as tmpl_photo,
               bt.video_url as tmpl_video, bt.media_type as tmpl_media_type,
               bt.button_text as tmpl_btn_text, bt.button_url as tmpl_btn_url,
               bt.type as tmpl_type, bt.speaker_photo_mode as tmpl_speaker_photo_mode,
               bt.subject as tmpl_subject
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        WHERE bs.id=$1 AND bs.event_id=$2
        """,
        schedule_id, event_id
    )
    if not schedule:
        raise HTTPException(status_code=404, detail="Задача не найдена")

    tpl_type = schedule["tmpl_type"] or schedule["type"]
    bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token, tz = await _load_test_targets(db, client_id)

    snap = None
    if tpl_type == "custom":
        import json as _json_b
        sb = schedule.get("snapshot_buttons")
        if isinstance(sb, str):
            try:
                sb = _json_b.loads(sb)
            except Exception:
                sb = []
        snap = {
            "text": schedule.get("snapshot_text") or "",
            "photo": schedule.get("snapshot_photo"),
            "video": schedule.get("snapshot_video"),
            "media_type": schedule.get("snapshot_media_type"),
            "buttons": sb or [],
        }
    content = await build_message_content(
        conn=db, tpl_type=tpl_type,
        tmpl_text=schedule["tmpl_text"] or "",
        photo_url=schedule["tmpl_photo"],
        btn_text=schedule["tmpl_btn_text"],
        btn_url=schedule["tmpl_btn_url"] or "",
        event_id=event_id, session_id=schedule.get("session_id"),
        fire_at=schedule["fire_at"], tz=tz,
        template_id=schedule.get("template_id"), snapshot=snap,
        video_url=schedule["tmpl_video"], media_type=schedule["tmpl_media_type"],
        speaker_photo_mode=schedule.get("tmpl_speaker_photo_mode") or "poster",
        subject=(schedule.get("snapshot_subject") or schedule.get("tmpl_subject")),
    )
    # subject → жирной первой строкой (как в реальной отправке).
    subj = (content.get("subject") or "").strip()
    if subj:
        content = dict(content)
        content["text"] = f"<b>{subj}</b>\n\n{content.get('text') or ''}"
    results = await _send_content_to_tests(content, bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token)
    sent = sum(1 for r in results if r.get("ok"))
    return {"ok": True, "sent": sent, "total": len(results), "results": results}


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
        video = content.get("video")
        m_type = content.get("media_type")
        btn_text = content.get("button_text")
        btn_url = content.get("button_url")

        # === Telegram ===
        if test_tg_ids and bot_token:
            for chat_id in [str(t) for t in test_tg_ids]:
                ok, err = await send_telegram_message(
                    http, bot_token, chat_id, text, photo, btn_text, btn_url,
                    video_url=video if m_type == "video" else None,
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
            if m_type == "video" and video:
                vk_text = f"{vk_text}\n\n🎬 Видео: {video}".strip()
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
            if m_type == "video" and video:
                max_text = f"{max_text}\n\n🎬 Видео: {video}".strip()
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

    if tpl["type"] == "expert_day":
        # «Экспертный день» шлём по каждому коллабу с учётом фильтра ролей
        # (intro_roles) — так же, как реальный fanout, а не по сессиям дня.
        intro_roles = tpl.get("intro_roles")
        if intro_roles is not None and len(intro_roles) == 0:
            sessions = []
        elif intro_roles:
            sessions = await db.fetch(
                """SELECT cse.id AS session_id, c.name AS speaker_name
                   FROM event_collaborators cse
                   JOIN collaborators c ON c.id = cse.speaker_id
                   WHERE cse.event_id=$1 AND cse.is_visible=true AND cse.role = ANY($2::text[])
                   ORDER BY """ + collaborator_sort.order_by_sql("cse"),
                event_id, intro_roles
            )
        else:
            sessions = await db.fetch(
                """SELECT cse.id AS session_id, c.name AS speaker_name
                   FROM event_collaborators cse
                   JOIN collaborators c ON c.id = cse.speaker_id
                   WHERE cse.event_id=$1 AND cse.is_visible=true
                   ORDER BY """ + collaborator_sort.order_by_sql("cse"),
                event_id
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
                    video_url=tpl["video_url"], media_type=tpl["media_type"],
                    speaker_photo_mode=tpl.get("speaker_photo_mode") or "poster",
                )
                speaker_results = await _send_one_content(http, content)
                results.append({"speaker": s["speaker_name"], "results": speaker_results})
        return {"ok": True, "sent": len(sessions), "details": results}

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
                    video_url=tpl["video_url"], media_type=tpl["media_type"],
                    speaker_photo_mode=tpl.get("speaker_photo_mode") or "poster",
                )
                speaker_results = await _send_one_content(http, content)
                results.append({"speaker": s["speaker_name"], "results": speaker_results})
        return {"ok": True, "sent": len(sessions), "details": results}

    else:
        # Для всех остальных (day_*, 30min_before, event_live, pre_conf и будущих) —
        # одна отправка. fire_at имитируем через первую сессию выбранного дня (конф/
        # турнир). Для мероприятия программы нет — берём events.start_at, чтобы
        # {day_datetime} и время старта подставились в тестовом сообщении.
        first_session = await db.fetchrow(
            """SELECT cs.start_time, d.day_date
                 FROM conf_sessions cs
                 LEFT JOIN conf_days d ON d.event_id = cs.event_id AND d.day_number = cs.day
                WHERE cs.event_id=$1 AND cs.day=$2 AND cs.start_time IS NOT NULL
                ORDER BY cs.start_time LIMIT 1""",
            event_id, day
        )
        fake_fire_at = _msk_str_to_utc(first_session["day_date"], first_session["start_time"]) if first_session else None
        if not fake_fire_at:
            fake_fire_at = await db.fetchval("SELECT start_at FROM events WHERE id=$1", event_id)

        content = await build_message_content(
            conn=db, tpl_type=tpl["type"],
            tmpl_text=tpl["text"], photo_url=tpl["photo_url"],
            btn_text=tpl["button_text"], btn_url=tpl["button_url"] or "",
            event_id=event_id, session_id=None,
            fire_at=fake_fire_at, tz=tz,
            template_id=tpl["id"],
            video_url=tpl["video_url"], media_type=tpl["media_type"],
        )
        async with httpx.AsyncClient(timeout=15) as http:
            send_results = await _send_one_content(http, content)
        return {"ok": True, "sent": 1, "details": [{"speaker": tpl["name"], "results": send_results}]}


# ─────────────────────────────────────────
# Хелпер
# ─────────────────────────────────────────
async def _check_event(db, event_id: int, client_id: int):
    event = await db.fetchrow(
        "SELECT id FROM events WHERE id=$1 AND id IN (SELECT event_id FROM event_owners WHERE client_id=$2 AND status='accepted')", event_id, client_id
    )
    if not event:
        raise HTTPException(status_code=404, detail="Событие не найдено")
