from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, time, timedelta
import asyncpg
import httpx
import logging
import re
from zoneinfo import ZoneInfo

# ⚠️ logger в модуле не был объявлен вовсе, хотя logger.warning уже вызывался
# (тестовое письмо, строка ~3185): в момент реального сбоя вызов упал бы
# NameError и утащил бы за собой всю тестовую отправку.
logger = logging.getLogger(__name__)

# ⚠️ ЕДИНЫЙ модуль подготовки и отправки на площадку — общий с боевой
# рассылкой (tasks/broadcast.py). Своей сборки сообщения в тесте быть не
# должно: именно от неё тест и бой разъезжались.
from app.services import platform_delivery as delivery


def _strip_first_name(text: str) -> str:
    """Убрать {first_name} из текста ТЕСТОВОЙ отправки.

    ⚠️ Заглушки («друг» и любые другие) не подставляем — ни в тесте, ни в бою.
    В тесте получателей несколько и у каждого своё имя, поэтому показываем
    текст без обращения; в реальной рассылке имя подставит Celery по каждому
    получателю (_apply_first_name в tasks/broadcast.py — та же логика).
    """
    from app.tasks.broadcast import _apply_first_name
    return _apply_first_name(text, None)


async def _support_link_preview(db, client_id: int) -> str:
    """Значение {support_link} для ПРЕВЬЮ и ТЕСТА.

    В реальной рассылке контакт подставляет Celery — свой для каждой площадки
    (в Telegram телеграм-контакт, в VK — ВК, в MAX — MAX). В превью платформа
    неизвестна (сообщение одно на все), поэтому показываем все каналы поддержки
    клиента блоком — так клиент видит, что плейсхолдер рабочий.
    """
    from app.services.support_message import build_support_inline_html
    row = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id=$1", client_id
    )
    if not row:
        return ""
    return build_support_inline_html(row["work_tg_username"], row["work_vk"], row["work_max"])


# Подписи кнопок регистрации в ПИСЬМЕ — одни на всю систему: боевая рассылка
# (tasks/broadcast.py), тестовая отправка и превью. Расходиться им нельзя:
# клиент проверяет одно, человек получает другое.
SIGNUP_BTN_LABELS: tuple[tuple[str, str], ...] = (
    ("telegram", "Зарегистрироваться через ТГ"),
    ("max", "Зарегистрироваться через МАХ"),
    ("vk", "Зарегистрироваться через ВК"),
)


async def _buttons_by_platform(db, client_id: int, event_id: int,
                               buttons: list, platforms: list[str]) -> dict:
    """Кнопки для КАЖДОЙ площадки превью.

    ⚠️ В письме кнопка с {signup_link} разворачивается в ТРИ — по одной на
    площадку (ограничение «один адрес» идёт от Telegram, к письму не
    относится). В мессенджере остаётся одна, со ссылкой своей площадки.
    Превью обязано показывать это различие, иначе клиент не видит, что
    реально уйдёт на почту.
    """
    from app.services.share_links import resolve_gift_funnel_tokens
    out: dict[str, list] = {}
    for p in platforms:
        signup = await _signup_link_preview(db, client_id, event_id, p)
        rows: list[dict] = []
        for b in (buttons or []):
            raw = (b.get("url") or "").strip()
            is_signup = raw in ("{signup_link}", "⟦SIGNUP⟧")
            if is_signup and p == "email":
                # Письмо: разворачиваем в три кнопки со своими адресами.
                for pp, label in SIGNUP_BTN_LABELS:
                    one = await _signup_link_preview(db, client_id, event_id, pp)
                    # ⚠️ У площадки без своего бота ссылка приходит СПИСКОМ
                    # (pick_signup_link отдаёт все с подписями) — такую кнопку
                    # не показываем: в кнопку помещается один адрес.
                    if one and "\n" not in one:
                        rows.append({"text": label, "url": one})
                continue
            url = await resolve_gift_funnel_tokens(
                db, client_id=client_id, text=raw, platform=p) if raw else ""
            url = (url or "").replace("⟦SIGNUP⟧", signup).replace("{signup_link}", signup)
            if url and "\n" not in url:
                rows.append({"text": b.get("text") or "Открыть", "url": url})
        out[p] = rows
    return out


async def _signup_link_preview(db, client_id: int, event_id: int,
                               platform: str = "telegram") -> str:
    """Значение {signup_link} для ПРЕВЬЮ и ТЕСТА — ссылка ЗАДАННОЙ площадки.

    ⚠️ Площадку передавать обязательно: у превью есть вкладки TG/VK/MAX, и на
    каждой должна стоять ссылка своего бота. Раньше здесь всегда бралась
    телеграмная — на вкладках ВК и МАКС показывалась чужая ссылка.
    Выключенные у события площадки исключаем и уводим на соседнюю (как рассылка),
    совсем ничего нет → веб-страница регистрации.
    """
    from app.services.share_links import (
        get_client_bot_handles, build_event_signup_links, pick_signup_link,
        get_event_disabled_platforms, get_client_vk_app_id,
    )
    from app.services.message_builder import resolve_landing_url
    handles = await get_client_bot_handles(db, client_id)
    slug = await db.fetchval("SELECT slug FROM events WHERE id = $1", event_id)
    # ⚠️ Режимы площадок — как в реальной рассылке (tasks/broadcast.py).
    # Иначе превью показывает бот-ссылку, а получателю уходит Mini App: клиент
    # проверяет одно, люди получают другое.
    _m = await db.fetchrow(
        "SELECT link_mode_telegram, link_mode_vk, link_mode_max FROM clients WHERE id=$1",
        client_id,
    )
    links = build_event_signup_links(
        handles, slug or "",
        modes={"telegram": _m["link_mode_telegram"], "vk": _m["link_mode_vk"],
               "max": _m["link_mode_max"]} if _m else {},
        vk_app_id=await get_client_vk_app_id(db, client_id),
    )
    for p in await get_event_disabled_platforms(db, event_id=event_id):
        links[p] = ""
    web = await resolve_landing_url(db, event_id) or ""
    return pick_signup_link(links, platform, web) or ""


def _tmpl_time_msk(tmpl, default_h: int, default_m: int) -> tuple[int, int]:
    """Время отправки шаблона «ЧЧ:ММ» (поле intro_start_time) → (часы, минуты).

    ⚠️ Раньше время у «за сутки» (09:12) и «анонса знакомства» (10:43) было
    зашито в коде — задать своё было негде, и рассылка вставала не в то время,
    а прошедшая молча пропускалась. Поле пустое → прежний час по умолчанию.
    """
    raw = ""
    try:
        raw = (tmpl["intro_start_time"] or "").strip()
    except (KeyError, TypeError):
        raw = ""
    if raw:
        try:
            parts = raw.split(":")
            return int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            pass
    return default_h, default_m


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
from app.services.email_body import build_email_body
from app.services.person_name import DISPLAY_NAME_SQL

RU_MONTHS = {
    1: "января", 2: "февраля", 3: "марта", 4: "апреля",
    5: "мая", 6: "июня", 7: "июля", 8: "августа",
    9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
}

def ru_date(d) -> str:
    return f"{d.day} {RU_MONTHS[d.month]}"

router = APIRouter(prefix="/events/{event_id}/broadcasts", tags=["Рассылки"])

# Типы, которых на событии может быть НЕСКОЛЬКО (и которые можно дублировать).
# Остальные — строго один на тип: в generate_schedules они лежат в tmpl_map
# (словарь по type), поэтому вторая копия молча не попала бы в генерацию.
DUPLICABLE_TYPES = {"custom", "expert_day", "speaker_intro"}


# ─────────────────────────────────────────
# ШАБЛОНЫ
# ─────────────────────────────────────────

def _nav_items_param(value):
    """Пункты навигации → параметр для JSONB-колонки.

    ⚠️ asyncpg не приводит list/dict к JSONB сам — нужна СТРОКА, иначе запрос
    падает с «invalid input for query argument». None оставляем как есть:
    это «не задано», а не пустой список.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    import json as _json
    return _json.dumps(value, ensure_ascii=False)


async def _preview_nav_resolved(db, schedule, event_id):
    """Пункты навигации со ссылками — тонкая обёртка над ЕДИНОЙ точкой.

    ⚠️⚠️ Вся логика живёт в `chat_nav.resolve_for_schedule`, которую зовёт и
    БОЕВАЯ отправка. Своего резолва здесь быть не должно: именно копия и
    разошлась с боем (client_id бывает NULL — тест слал заголовок без ссылок).
    Здесь остаётся только «не падать»: превью важнее пунктов в нём.
    """
    try:
        from app.services.chat_nav import resolve_for_schedule
        return await resolve_for_schedule(db, schedule, event_id)
    except Exception:
        return []


def _apply_nav_preview(text, resolved, platform):
    """Подставить пункты навигации в текст превью для этой площадки."""
    if not text or "{chat_nav_items}" not in text:
        return text or ""
    from app.services.chat_nav import apply_nav_items
    return apply_nav_items(text, resolved, platform)


def _parse_nav_items(raw):
    """JSONB-пункты из базы → список для фронта (asyncpg отдаёт их строкой)."""
    if not raw:
        return []
    if isinstance(raw, str):
        import json as _json
        try:
            raw = _json.loads(raw)
        except (ValueError, TypeError):
            return []
    return raw if isinstance(raw, list) else []


async def _fill_magnet_slugs(db, items):
    """Дописать пунктам-лид-магнитам их `slug`.

    ⚠️ Фронт выбирает магнит ПИКЕРОМ, а тот отдаёт только `{kind, id}` — он
    общий на весь кабинет (LeadMagnetPicker) и про slug ничего не знает.
    Ссылка же строится именно по slug (воронка живёт в боте ХОЗЯИНА магнита).
    Резолвим здесь, в одной точке: иначе каждый экран искал бы slug сам и
    рано или поздно прислал бы чужой.
    """
    if not items:
        return items
    out = []
    for it in items:
        it = dict(it or {})
        if it.get("kind") == "magnet":
            # ⚠️ slug ищем ЗАНОВО на каждом сохранении, а не только когда его
            # нет: клиент мог сменить магнит в пункте, и сохранённый slug
            # указывал бы на прежний — ссылка вела бы не туда, причём молча.
            it.pop("magnet_slug", None)
            if it.get("magnet_id"):
                mkind = (it.get("magnet_kind") or "m").strip()
                table = "lead_magnet_packages" if mkind == "p" else "lead_magnets"
                try:
                    slug = await db.fetchval(
                        f"SELECT slug FROM {table} WHERE id = $1", int(it["magnet_id"]))
                except (TypeError, ValueError):
                    slug = None
                if slug:
                    it["magnet_slug"] = slug
        out.append(it)
    return out


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
    # Привязка кастомного шаблона (миграция 260): 'day' (день программы, как было),
    # 'slot' (слот спикера — раскрываются спикерские плейсхолдеры), 'none' (без привязки).
    custom_bind_kind: Optional[str] = None
    custom_slot_session_id: Optional[int] = None   # conf_sessions.id для bind_kind='slot'
    custom_slot_offset_min: Optional[int] = None   # смещение от старта слота, мин (может быть <0)
    custom_fire_at: Optional[str] = None           # 'YYYY-MM-DDTHH:MM' для bind_kind='none'
    # Каналы для отправки: NULL/None = все каналы клиента (default), [] = никуда,
    # [N,M] = только эти channel_id. Унаследуется в schedules через generate_schedules.
    target_channel_ids: Optional[List[int]] = None
    # Слать ещё и в групповые чаты события (tg/vk/max_chat_id) — в ДОПОЛНЕНИЕ к базе.
    send_to_event_chats: Optional[bool] = None
    # Слать ещё и в общую базу чатов клиента (client_broadcast_chats, is_private=FALSE).
    send_to_client_chats: Optional[bool] = None
    # Слать ещё и в личные каналы клиента (client_broadcast_chats, is_private=TRUE).
    send_to_private_chats: Optional[bool] = None
    # Слать в ЧАТ СПИКЕРОВ события (миграция 431) — отдельный от чата участников.
    send_to_speakers_chat: Optional[bool] = None
    # Закреплять сообщение в чате после отправки (TG/VK/MAX). Нужны права админа у бота.
    pin_in_chat: Optional[bool] = None
    # Пункты навигации для типа chat_nav: [{kind,label,url,magnet_kind,magnet_slug}].
    # Ссылки у пунктов резолвятся при отправке — под площадку чата (chat_nav.py).
    nav_items: Optional[List[dict]] = None
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
    custom_bind_kind: Optional[str] = None      # 'none' | 'day' | 'slot' (миграция 260)
    custom_slot_session_id: Optional[int] = None
    custom_slot_offset_min: Optional[int] = None
    custom_fire_at: Optional[str] = None
    target_channel_ids: Optional[List[int]] = None
    send_to_event_chats: Optional[bool] = None
    send_to_client_chats: Optional[bool] = None
    send_to_private_chats: Optional[bool] = None
    send_to_speakers_chat: Optional[bool] = None
    # Закреплять сообщение в чате после отправки (TG/VK/MAX).
    pin_in_chat: Optional[bool] = None
    # Пункты навигации для типа chat_nav (см. chat_nav.py).
    nav_items: Optional[List[dict]] = None
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
            "Здравствуйте!\n\n"
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
        # «Вы следующие» — служебное сообщение В ЧАТ СПИКЕРОВ за 15 минут до
        # выступления по программе. Участникам НЕ уходит: audience_exclude
        # обнуляет список получателей, а доставка идёт по send_to_speakers_chat.
        "name": "Спикеру: «вы следующие» (в чат спикеров)",
        "type": "speakers_call",
        "text": (
            "<b>{speaker_name} ({speaker_tg_username}) — заходите в зум через 5 минут</b>\n\n"
            "Ваше выступление в {speaker_time}\n\n"
            "Ссылка для входа (Zoom):\n"
            "{speaker_join_url}\n\n"
            "Ссылка на эфир: {stream_url}\n\n"
            "—————\n\n"
            "Готовится к {next_speaker_time}: {next_speaker_name} ({next_speaker_tg_username})\n\n"
            "—————\n\n"
            "Поставьте реакцию — что вы на связи."
        ),
        "photo_url": None,
        "button_text": None,
        "button_url": None,
        "schedule_mode": "fixed_offset",
        "offset_minutes": 15,
        "audience_include": "all_event",
        "audience_exclude": "all_event",   # ← участникам не шлём, только в чат
        "allow_custom_datetime": False,
        "send_to_speakers_chat": True,
    },
    {
        # Программа дня В ЧАТ СПИКЕРОВ — накануне. Спикеру нужен не список тем,
        # а тайминг: во сколько он и кто рядом. Отсюда свой {day_program_speakers}.
        "name": "Спикерам: программа дня (в чат спикеров)",
        "type": "speakers_day",
        "text": (
            "<b>Программа выступлений на завтра</b>\n\n"
            "Уважаемые спикеры! Напоминаем вам тайминг завтрашнего дня — {day_date}\n\n"
            "{day_program_speakers}\n\n"
            # ⚠️ Ссылки — В КОНЦЕ и каждая своей строкой через пустую строку
            # (23.09.2026): спикеру нужен сначала тайминг, а перед эфиром —
            # быстро найти, куда заходить. В гуще программы ссылки теряются.
            #
            # ⚠️ ДВЕ РАЗНЫЕ ссылки, не путать: {stream_url} — вебинарная
            # комната (её же видят зрители), {speaker_join_url} — вход в Zoom
            # для самого спикера. У каждого дня свой Zoom.
            #
            # ⚠️ Пустой плейсхолдер убирает свою строку целиком — у события
            # может не быть Zoom вовсе, и «Зум дня:» без ссылки хуже, чем
            # ничего.
            "Вебинарная комната: {stream_url}\n\n"
            "Зум дня (для спикеров): {speaker_join_url}"
        ),
        "photo_url": None,
        "button_text": None,
        "button_url": None,
        "schedule_mode": "fixed_offset",
        "offset_minutes": 1440,            # за сутки до старта дня
        "audience_include": "all_event",
        "audience_exclude": "all_event",   # ← участникам не шлём, только в чат
        "allow_custom_datetime": False,
        "send_to_speakers_chat": True,
        # ⚠️ ЗАКРЕПЛЯЕМ в чате спикеров (23.09.2026): тайминг нужен команде весь
        # день, а в живом чате он за час уезжает вверх под обсуждением. Закреп
        # держит его на виду — за этим в чат и заходят.
        #
        # ⚠️ У «вы следующие» (`speakers_call`) закрепа НЕТ намеренно: она
        # уходит перед КАЖДЫМ выступлением и перебивала бы закреп по десять раз
        # за день, вытесняя программу — то есть ровно то, что нужно держать.
        "pin_in_chat": True,
    },
    {
        # ⚠️ Инструкция по подключению — ОТДЕЛЬНО от программы дня, хотя уходит
        # следом за ней (23.09.2026). Одним сообщением нельзя: программа нужна
        # накануне («во сколько я завтра»), а инструкция — в день эфира, и
        # закреплять надо обе. Слепив их, пришлось бы выбирать одно время.
        "name": "Спикерам: инструкция по подключению (в чат спикеров)",
        "type": "speakers_howto",
        "text": (
            "<b>ИНСТРУКЦИЯ ПО ПОДКЛЮЧЕНИЮ К ТРАНСЛЯЦИИ</b>\n\n"
            "Ссылки в закреп в день конференции\n\n"
            "<b>1) Ссылка на ZOOM:</b>\n"
            "{speaker_join_url}\n\n"
            "Сюда заходите за 10 минут до своего выступления и ведёте выступление отсюда — "
            "будет доступ к демонстрации экрана\n\n"
            "<b>2) Ссылка на вебинарную комнату:</b>\n"
            "{stream_url}\n\n"
            "Заходите сюда с телефона (выключаете звук, чтобы не фонило) и читаете "
            "комментарии зрителей\n\n"
            "—\n\n"
            "Итого: выступление ведёте в зуме со мной\n\n"
            "Зрители и комментарии — в чате вебинарной комнаты\n\n"
            "Задержка 10 секунд — поэтому не пугайтесь тишины в ответ, не ждите долго ответов\n\n"
            "Общайтесь с аудиторией: если им не задавать вопросы, она будет молчать\n\n"
            "{day_speakers_mentions}"
        ),
        "photo_url": None,
        "button_text": None,
        "button_url": None,
        "schedule_mode": "fixed_offset",
        # ⚠️ Через минуту ПОСЛЕ программы дня: два сообщения подряд в одном
        # чате, инструкция второй — сначала «во сколько я», потом «куда
        # заходить». Обратный порядок читается как инструкция в пустоту.
        "offset_minutes": 1439,            # = 1440 (сутки) − 1 минута
        "intro_start_time": None,          # своё время задаётся в настройках
        "audience_include": "all_event",
        "audience_exclude": "all_event",   # ← участникам не шлём, только в чат
        "allow_custom_datetime": False,
        "send_to_speakers_chat": True,
        "pin_in_chat": True,
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
        "name": "Начинаем День события",
        "type": "day_live",
        "text": (
            "Мы начинаем {day_title} : «{conf_title}»\n\n"
            "<b>Нажимай на кнопку «Войти в эфир»</b>\n"
            "👇🏻👇🏻👇🏻\n"
            "{stream_url}\n\n"
            "—\n"
            "При возникновении технических трудностей пишите — {support_platform}"
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
            "Здравствуйте, {first_name}!\n\n"
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


# У ТУРНИРА нет «конференции» — есть «событие», а знакомство охватывает ещё и жюри.
# Здесь только СТАРТОВЫЕ название и текст шаблона (дальше клиент правит их сам).
# Одна точка правки на оба места, где шаблон берётся из DEFAULT_TEMPLATES:
# авто-сид (list_templates) и пресеты (_allowed_preset_types_for_event).
_TURNIR_TEMPLATE_NAMES = {
    "speaker_intro": "Знакомство со спикерами и жюри",
    "speakers_call": "Спикеру/номинанту: «вы следующие» (в чат)",
    "speakers_day": "Спикерам/номинантам: программа дня (в чат)",
    "speakers_howto": "Спикерам/номинантам: инструкция по подключению (в чат)",
    "day_end": "День события (итоги дня + подарки)",
}

_TURNIR_TEMPLATE_TEXTS = {
    "day_end": (
        "Благодарим вас за участие в {day_ordinal} дне события «{conf_title}»\n\n"
        "Самое время ввести собранные КОДОВЫЕ СЛОВА и получить за них дополнительные билеты для розыгрыша:\n"
        "{raffle_url}\n\n"
        "<b>{next_day_mention}</b>\n\n"
        "—\n\n"
        "{day_speakers_gifts}"
    ),
}


def _template_name_for_event(tpl: dict, is_turnir: bool) -> str:
    """Имя шаблона с учётом типа события (у турнира — «День события», не «конференции»)."""
    if is_turnir:
        return _TURNIR_TEMPLATE_NAMES.get(tpl["type"], tpl["name"])
    return tpl["name"]


def _template_text_for_event(tpl: dict, is_turnir: bool, is_plain_event: bool) -> str:
    """Стартовый текст шаблона: у турнира — без слова «конференция», у мероприятия
    (без программы по дням) — альтернативный text_event, если он задан."""
    if is_turnir and tpl["type"] in _TURNIR_TEMPLATE_TEXTS:
        return _TURNIR_TEMPLATE_TEXTS[tpl["type"]]
    if is_plain_event and tpl.get("text_event"):
        return tpl["text_event"]
    return tpl["text"]


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
               custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at,
               target_channel_ids, send_to_event_chats, send_to_client_chats, send_to_private_chats,
               send_to_speakers_chat, pin_in_chat, nav_items, intro_roles,
               speaker_photo_mode,
               created_at
        FROM broadcast_templates
        WHERE event_id = $1
        ORDER BY type, created_at
        """,
        event_id
    )

    if not rows:
        # Авто-сид: копируем клиенту шаблоны библиотеки (default_broadcast_templates,
        # правится в админке), доступные ЭТОМУ типу события и помеченные autoseed.
        # Принадлежность модулю — флаги for_event / for_conference / for_turnir.
        ev_row = await db.fetchrow("SELECT module_slug, is_collab FROM events WHERE id=$1", event_id)
        is_conf = bool(ev_row and ev_row["module_slug"] == "conference")
        is_turnir = bool(ev_row and ev_row["module_slug"] == "turnir")
        # У коллабы module_slug='base' — тип события её не выдаёт, нужен свой флаг.
        is_collab = bool(ev_row and ev_row["is_collab"])
        for tpl in await _allowed_preset_types_for_event(db, is_conf, is_turnir, for_presets=False, is_collab=is_collab, client_id=client_id):
            await db.execute(
                """
                INSERT INTO broadcast_templates
                  (client_id, event_id, name, type, subject, text, photo_url, button_text, button_url,
                   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                   send_to_speakers_chat, send_to_event_chats, pin_in_chat, nav_items)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                """,
                client_id, event_id, tpl["name"], tpl["type"], tpl.get("subject"),
                tpl["text"], tpl.get("photo_url"), tpl.get("button_text"), tpl.get("button_url"),
                tpl.get("schedule_mode", "fixed_offset"), tpl.get("offset_minutes", 0),
                tpl.get("audience_include", "all_event"), tpl.get("audience_exclude", "none"),
                bool(tpl.get("allow_custom_datetime", False)),
                bool(tpl.get("send_to_speakers_chat", False)),
                # ⚠️ Доставку в чат и закреп обязан копировать САМ авто-сид:
                # у chat_nav адресат — чат события, и без флага шаблон ушёл бы
                # в личку всей базе. Раньше эти колонки сид не копировал вовсе.
                bool(tpl.get("send_to_event_chats", False)),
                bool(tpl.get("pin_in_chat", False)),
                _nav_items_param(tpl.get("nav_items")),
            )
        rows = await db.fetch(
            """
            SELECT id, name, type, text, photo_url, button_text, button_url,
                   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                   target_channel_ids,
                   -- ⚠️ Нужен фронту: по нему шаблоны делятся на группы
                   -- «для участников» / «в чат спикеров». Без него у ТОЛЬКО ЧТО
                   -- созданного события (эта ветка — сразу после авто-сида)
                   -- группировка не сработала бы.
                   send_to_speakers_chat,
                   -- ⚠️ По той же причине: у только что созданного события
                   -- редактор навигации должен открыться с уже заполненными
                   -- пунктами, а не пустым.
                   send_to_event_chats, pin_in_chat, nav_items,
                   created_at
            FROM broadcast_templates
            WHERE event_id = $1
            ORDER BY type, created_at
            """,
            event_id
        )

    # Дефолтная афиша события — ТОЛЬКО ДЛЯ ПОКАЗА в дашборде, отдельным полем.
    #
    # ⚠️ Раньше она подмешивалась прямо в `photo_url` шаблона. Фронт при сохранении
    # слал это значение обратно — и «афиша для превью» оседала в БД как «своё фото
    # шаблона». В итоге у шаблона было фото, которого клиент не загружал, и оно
    # перебивало афишу ДНЯ (приоритет: фото шаблона > афиша дня > общая афиша).
    # Теперь photo_url остаётся ровно тем, что задал клиент (обычно пустым), а
    # афиша подставляется при отправке — там же, где решается приоритет.
    from app.services.message_builder import get_default_event_photo
    default_poster = await get_default_event_photo(db, event_id)
    result = []
    for r in rows:
        d = dict(r)
        d["default_photo_url"] = default_poster if not d["photo_url"] else None
        # ⚠️ JSONB из asyncpg приходит СТРОКОЙ (декодер не настроен). Без
        # разбора редактор навигации получил бы строку вместо списка и показал
        # «пунктов нет» у заполненного шаблона. Та же ошибка уже ловилась на
        # лендингах (event_landing._ser_page).
        d["nav_items"] = _parse_nav_items(d.get("nav_items"))
        result.append(d)
    return {"templates": result}


async def _resolve_custom_binding(db, event_id: int, data, tz: ZoneInfo) -> dict:
    """Разбирает привязку кастомного шаблона (миграция 260) и валидирует её.

    Возвращает {bind_kind, slot_session_id, slot_offset_min, fire_at (aware UTC)}.
    'day'  — день программы (custom_day_ref) + custom_time, как было до 260.
    'slot' — слот спикера: нужен существующий conf_sessions.id этого события.
    'none' — абсолютные дата+время (custom_fire_at, локальные для клиента).
    """
    kind = (getattr(data, "custom_bind_kind", None) or "").strip().lower() or None
    if kind is None:
        return {"bind_kind": None, "slot_session_id": None,
                "slot_offset_min": None, "fire_at": None}
    if kind not in ("none", "day", "slot"):
        raise HTTPException(status_code=400, detail="Неверный тип привязки шаблона")

    slot_id = None
    offset_min = None
    fire_at = None

    if kind == "slot":
        slot_id = getattr(data, "custom_slot_session_id", None)
        if not slot_id:
            raise HTTPException(status_code=400, detail="Выберите слот программы (выступление спикера)")
        ok = await db.fetchval(
            "SELECT 1 FROM conf_sessions WHERE id=$1 AND event_id=$2", slot_id, event_id)
        if not ok:
            raise HTTPException(status_code=400, detail="Выбранный слот не найден в программе этого события")
        offset_min = getattr(data, "custom_slot_offset_min", None)
        offset_min = 0 if offset_min is None else int(offset_min)
    elif kind == "none":
        raw = (getattr(data, "custom_fire_at", None) or "").strip()
        if not raw:
            raise HTTPException(status_code=400, detail="Укажите дату и время отправки")
        try:
            fire_at = _parse_fire_at(raw, tz)
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=400, detail="Неверный формат даты отправки")
    else:  # day
        if not (getattr(data, "custom_day_ref", None) or "").strip():
            raise HTTPException(status_code=400, detail="Выберите день отправки")

    return {"bind_kind": kind, "slot_session_id": slot_id,
            "slot_offset_min": offset_min, "fire_at": fire_at}


async def _client_tz(db, client_id: int) -> ZoneInfo:
    row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    return ZoneInfo((row["timezone"] or "Europe/Moscow") if row else "Europe/Moscow")


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

    bind = await _resolve_custom_binding(db, event_id, data, await _client_tz(db, client_id))

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates
          (client_id, event_id, name, type, subject, text, photo_url, button_text, button_url,
           audience_include, audience_exclude, custom_day_ref, custom_time,
           schedule_mode, allow_custom_datetime, target_channel_ids,
           video_url, media_type, send_to_event_chats, send_to_client_chats, send_to_private_chats,
           send_to_speakers_chat, speaker_photo_mode,
           custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at,
           pin_in_chat, nav_items)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                COALESCE($10, 'all_event'), COALESCE($11, 'none'),
                $12, $13,
                COALESCE($14, schedule_mode), COALESCE($15, allow_custom_datetime), $16,
                $17, $18, COALESCE($19, FALSE), COALESCE($20, FALSE), COALESCE($21, FALSE),
                COALESCE($27, FALSE), COALESCE($22, 'poster'),
                $23, $24, $25, $26,
                COALESCE($28, FALSE), $29)
        RETURNING id, name, type, subject, text, photo_url, video_url, media_type, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  custom_day_ref, custom_time, target_channel_ids, send_to_event_chats, send_to_client_chats,
                  send_to_private_chats, send_to_speakers_chat, speaker_photo_mode,
                  custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at,
                  pin_in_chat, nav_items,
                  created_at
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
        bind["bind_kind"], bind["slot_session_id"], bind["slot_offset_min"], bind["fire_at"],
        data.send_to_speakers_chat,
        data.pin_in_chat, _nav_items_param(await _fill_magnet_slugs(db, data.nav_items)),
    )
    row = dict(row)
    row["nav_items"] = _parse_nav_items(row.get("nav_items"))
    return dict(row)


async def load_default_templates(db) -> list[dict]:
    """Библиотека дефолтных шаблонов — из БД (миграция 217), ею управляет админка.

    Список в коде (DEFAULT_TEMPLATES) остаётся ФОЛБЭКОМ: если таблица ещё не
    заполнена (сид не прогнан), работаем как раньше — ничего не ломается.
    """
    try:
        rows = await db.fetch(
            """
            SELECT type, name, subject, text, text_event, photo_url, button_text, button_url,
                   schedule_mode, offset_minutes, audience_include, audience_exclude,
                   allow_custom_datetime, for_event, for_conference, for_turnir,
                   for_collab,
                   autoseed, multi_instance, turnir_name, turnir_text,
                   send_to_speakers_chat, send_to_event_chats, pin_in_chat, nav_items
              FROM default_broadcast_templates
             WHERE is_active
             ORDER BY sort_order, id
            """
        )
    except asyncpg.PostgresError:
        rows = []
    if not rows:
        return []
    return [dict(r) for r in rows]


def _fallback_flags(t: str, for_presets: bool) -> dict:
    """Прежняя (захардкоженная) принадлежность шаблона модулям — для фолбэка,
    пока библиотека в БД не заполнена."""
    EVENT_ONLY = {
        "30min_before", "2h_before_unreg", "2h_before_reg",
        "day_before_09_12_unreg", "day_before_09_12_reg", "event_live",
    }
    TURNIR_EXTRA = {"speaker_intro", "5min_before", "day_live",
                    "speakers_call", "speakers_day", "speakers_howto"}
    if for_presets:
        TURNIR_EXTRA = TURNIR_EXTRA | {"pre_conf", "gift", "day_end", "expert_day"}
    return {
        # speakers_call («вы следующие» в чат спикеров) — только там, где есть
        # программа по слотам: у мероприятия спикеров нет вовсе.
        "for_event": t in EVENT_ONLY,
        "for_conference": t != "event_live",
        "for_turnir": (t in EVENT_ONLY or t in TURNIR_EXTRA) and t != "event_live",
        "autoseed": t != "expert_day",
        # ⚠️ speaker_intro сюда НЕ входит: в списке «готовых шаблонов» повторно
        # предлагать его не нужно — вторая копия делается кнопкой «Дублировать»
        # (готовый пресет затёр бы уже настроенный текст и тайминг).
        "multi_instance": t in {"vip_offer", "custom", "expert_day"},
    }


# Типы шаблонов, закрытые ФИЧЕЙ: {тип: slug фичи}. Нет фичи — шаблон не
# предлагается ни в авто-сиде, ни в «Добавить готовый шаблон».
# ⚠️ Закрыт только САМ шаблон. Поля чата спикеров и ссылки входа в зум —
# обычные настройки события, доступны всем и гейтом не трогаются.
_FEATURE_GATED_TYPES = {
    "speakers_call": "speakers_call",   # «вы следующие» за 15 минут
    "speakers_day": "speakers_call",    # программа дня накануне — та же фича
    # Инструкция уходит следом за программой, в тот же чат — фича та же.
    "speakers_howto": "speakers_call",
}


async def _allowed_preset_types_for_event(db, is_conf: bool, is_turnir: bool,
                                          for_presets: bool = False,
                                          is_collab: bool = False,
                                          client_id: int | None = None) -> list[dict]:
    """Шаблоны библиотеки, доступные этому типу события.

    Принадлежность модулю — по флагам for_event / for_conference / for_turnir /
    for_collab (правятся в админке). Раньше это был клубок if-ов по типам.

    ⚠️ Коллаб-событие проверяется ОТДЕЛЬНЫМ флагом (миграция 313). По
    module_slug оно 'base', то есть для подбора выглядит как обычное
    мероприятие, — а спикерские шаблоны (знакомство со спикерами, за 5 минут
    до выступления, подарок после выступления) помечены только for_conference.
    Поэтому у коллабы их не было вовсе, хотя выступления там есть. Включить им
    for_event нельзя: они появились бы у всех вебинаров и эфиров, где спикеров
    нет в принципе.

    for_presets=False — режим АВТО-СИДА (создание события): берём только те,
    у кого autoseed=TRUE. for_presets=True — «Добавить готовый шаблон»: берём все.
    """
    is_plain_event = not is_conf and not is_turnir and not is_collab
    lib = await load_default_templates(db)
    if not lib:
        # Фолбэк: библиотека ещё не заполнена — работаем от кода, как раньше.
        lib = [{**t, **_fallback_flags(t["type"], for_presets),
                "turnir_name": _TURNIR_TEMPLATE_NAMES.get(t["type"]),
                "turnir_text": _TURNIR_TEMPLATE_TEXTS.get(t["type"])}
               for t in DEFAULT_TEMPLATES]

    # Какие из закрытых фичами типов доступны этому клиенту. Считаем один раз
    # на весь список: иначе на каждый шаблон уходил бы запрос в базу.
    gated_ok: dict[str, bool] = {}
    if client_id is not None:
        from app.services.features import client_has_feature
        for t, slug in _FEATURE_GATED_TYPES.items():
            gated_ok[t] = await client_has_feature(db, client_id, slug)

    out = []
    for tpl in lib:
        # Шаблон под фичей: без неё не показываем вовсе. client_id не передан —
        # считаем, что доступа нет (безопасная сторона: лучше не показать, чем
        # дать поставить в очередь рассылку, которой у клиента быть не должно).
        if tpl["type"] in _FEATURE_GATED_TYPES and not gated_ok.get(tpl["type"]):
            continue
        if is_conf and not tpl.get("for_conference"):
            continue
        if is_turnir and not tpl.get("for_turnir"):
            continue
        # ⚠️ Проверяется ДО is_plain_event: у коллабы module_slug='base', иначе
        # она провалилась бы в ветку обычного мероприятия и снова осталась без
        # спикерских шаблонов.
        if is_collab and not tpl.get("for_collab", tpl.get("for_event")):
            continue
        if is_plain_event and not tpl.get("for_event"):
            continue
        if not for_presets and not tpl.get("autoseed", True):
            continue
        # Название/текст под тип события: у турнира «событие», а не «конференция»;
        # у мероприятия — вариант текста без программы по дням.
        name = (tpl.get("turnir_name") or tpl["name"]) if is_turnir else tpl["name"]
        text = tpl["text"]
        if is_turnir and tpl.get("turnir_text"):
            text = tpl["turnir_text"]
        elif is_plain_event and tpl.get("text_event"):
            text = tpl["text_event"]
        out.append({**tpl, "name": name, "text": text})
    return out


# Типы, которых у события может быть несколько (произвольные продающие/анонсные).
# Их не «прячем» из пресетов, даже если один такой уже создан.
# ⚠️ Источник истины — колонка multi_instance в default_broadcast_templates;
# эта константа осталась только как фолбэк для типа custom (его нет в библиотеке).
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
    ev_row = await db.fetchrow("SELECT module_slug, is_collab FROM events WHERE id=$1", event_id)
    is_conf = bool(ev_row and ev_row["module_slug"] == "conference")
    is_turnir = bool(ev_row and ev_row["module_slug"] == "turnir")
    # У коллабы module_slug='base' — тип события её не выдаёт, нужен свой флаг.
    is_collab = bool(ev_row and ev_row["is_collab"])

    existing_types = {r["type"] for r in await db.fetch(
        "SELECT DISTINCT type FROM broadcast_templates WHERE event_id=$1", event_id
    )}
    presets = []
    for tpl in await _allowed_preset_types_for_event(db, is_conf, is_turnir, for_presets=True, is_collab=is_collab, client_id=client_id):
        # Уже существующий одиночный тип — не предлагаем повторно.
        multi = tpl.get("multi_instance", tpl["type"] in MULTI_INSTANCE_PRESET_TYPES)
        if tpl["type"] in existing_types and not multi:
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
    """Создаёт шаблон по типу из библиотеки (default_broadcast_templates) — с её
    текстом/кнопкой. То, что отредактировано в админке, попадает сюда сразу."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    ev_row = await db.fetchrow("SELECT module_slug, is_collab FROM events WHERE id=$1", event_id)
    is_conf = bool(ev_row and ev_row["module_slug"] == "conference")
    is_turnir = bool(ev_row and ev_row["module_slug"] == "turnir")
    # У коллабы module_slug='base' — тип события её не выдаёт, нужен свой флаг.
    is_collab = bool(ev_row and ev_row["is_collab"])

    tpl = next((t for t in await _allowed_preset_types_for_event(db, is_conf, is_turnir, for_presets=True, is_collab=is_collab, client_id=client_id)
                if t["type"] == data.type), None)
    if not tpl:
        raise HTTPException(status_code=400, detail="Такой готовый шаблон недоступен для этого события")

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates
          (client_id, event_id, name, type, subject, text, photo_url, button_text, button_url,
           schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
           send_to_speakers_chat, send_to_event_chats, pin_in_chat, nav_items)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING id, name, type, subject, text, photo_url, video_url, media_type, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  custom_day_ref, custom_time, target_channel_ids,
                  send_to_speakers_chat, send_to_event_chats, pin_in_chat, nav_items, created_at
        """,
        client_id, event_id, tpl["name"], tpl["type"], tpl.get("subject"),
        tpl["text"], tpl.get("photo_url"), tpl.get("button_text"), tpl.get("button_url"),
        tpl.get("schedule_mode", "fixed_offset"), tpl.get("offset_minutes", 0),
        tpl.get("audience_include", "all_event"), tpl.get("audience_exclude", "none"),
        bool(tpl.get("allow_custom_datetime", False)),
        # ⚠️ Без этого шаблон, добавленный кнопкой «Добавить шаблон», получал
        # флаг FALSE: не попадал в группу «в чат спикеров» и — хуже — вообще
        # никуда не уходил бы при отправке. Авто-сид флаг переносил, а эта
        # ручка нет: расходились два пути создания одного и того же шаблона.
        bool(tpl.get("send_to_speakers_chat", False)),
        # ⚠️ Та же история с навигацией по чату: у существующих конференций и
        # премий это ЕДИНСТВЕННЫЙ путь добавления (авто-сид отработал давно).
        # Без флагов шаблон ушёл бы в личку всей базе вместо чата, а редактор
        # открылся бы с пустым списком вместо заполненного.
        bool(tpl.get("send_to_event_chats", False)),
        bool(tpl.get("pin_in_chat", False)),
        _nav_items_param(tpl.get("nav_items")),
    )
    row = dict(row)
    row["nav_items"] = _parse_nav_items(row.get("nav_items"))
    return row


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

    # ⚠️ speakers_call — доставка ЗАФИКСИРОВАНА: только чат спикеров, никогда
    # участникам. В кабинете этих полей у типа и нет (выбирать нечего: чат один
    # и задан в настройках события), но PATCH мог прийти со старой формы или из
    # bulk-правки — и тогда служебное «вы следующие» ушло бы всей базе.
    # Цена ошибки — рассылка на всю аудиторию, поэтому держим на бэке, а не
    # только в UI.
    # ⚠️ Эти рассылки идут ТОЛЬКО в чат спикеров: выбор аудитории у них
    # отключён и на бэке, а не только в интерфейсе — цена ошибки тут
    # рассылка инструкции для спикеров на всю базу участников.
    if data.type in ("speakers_call", "speakers_day", "speakers_howto"):
        data.send_to_speakers_chat = True
        data.send_to_event_chats = False
        data.send_to_client_chats = False
        data.send_to_private_chats = False
        data.audience_include = "all_event"
        data.audience_exclude = "all_event"   # вычитает всех участников → в личку никому

    # ⚠️ chat_nav — навигация ПО ЧАТУ: адресат только чат события, в личку не
    # уходит никогда. Тот же случай, что speakers_call: цена ошибки — рассылка
    # на всю базу, поэтому фиксируем на бэке, а не только в UI. Закреп тоже
    # держим включённым: навигация без закрепа утонет в чате за час.
    if data.type == "chat_nav":
        data.send_to_event_chats = True
        data.send_to_speakers_chat = False
        data.audience_include = "all_event"
        data.audience_exclude = "all_event"   # в личку никому

    # Привязка (миграция 260) меняется ТОЛЬКО если фронт её прислал. Иначе поля не
    # трогаем — иначе переключение «слот → день» не смогло бы обнулить старый слот
    # (COALESCE оставил бы его навсегда).
    bind_sent = "custom_bind_kind" in data.model_fields_set
    bind = (await _resolve_custom_binding(db, event_id, data, await _client_tz(db, client_id))
            if bind_sent else None)

    # Время отправки: COALESCE не даёт ОЧИСТИТЬ поле (null молча оставляет старое),
    # а для «итогов дня» пустое значение — осмысленный выбор «считать от конца
    # программы дня». Поэтому пустую строку от фронта трактуем как явную очистку.
    _time_sent = "intro_start_time" in data.model_fields_set
    _time_clear = _time_sent and not (data.intro_start_time or "").strip()

    # Пункты навигации пишем, ТОЛЬКО если фронт их прислал. Через COALESCE
    # нельзя: удаление последнего пункта прислало бы пустой список, а COALESCE
    # молча вернул бы прежние — пункт было бы не удалить. Тот же приём, что
    # у привязки шаблона (bind_sent) и у intro_start_time.
    _nav_sent = "nav_items" in data.model_fields_set
    _nav_value = await _fill_magnet_slugs(db, data.nav_items) if _nav_sent else None

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
            intro_start_time = CASE WHEN $33::bool THEN NULL
                                    ELSE COALESCE($13, intro_start_time) END,
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
            send_to_speakers_chat = COALESCE($34, send_to_speakers_chat),
            pin_in_chat = COALESCE($35, pin_in_chat),
            nav_items = CASE WHEN $36::bool THEN $37::jsonb ELSE nav_items END,
            speaker_photo_mode = COALESCE($27, speaker_photo_mode),
            custom_bind_kind       = CASE WHEN $28 THEN $29 ELSE custom_bind_kind END,
            custom_slot_session_id = CASE WHEN $28 THEN $30 ELSE custom_slot_session_id END,
            custom_slot_offset_min = CASE WHEN $28 THEN $31 ELSE custom_slot_offset_min END,
            custom_fire_at         = CASE WHEN $28 THEN $32 ELSE custom_fire_at END,
            updated_at = NOW()
        WHERE id = $19 AND event_id = $20
        RETURNING id, name, type, subject, text, photo_url, video_url, media_type, button_text, button_url,
                  schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
                  intro_start_time, intro_interval_min, intro_days_before,
                  custom_day_ref, custom_time, target_channel_ids, send_to_event_chats,
                  send_to_client_chats, send_to_private_chats, send_to_speakers_chat,
                  pin_in_chat, nav_items,
                  intro_roles, speaker_photo_mode,
                  custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at
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
        bind_sent,
        bind["bind_kind"] if bind else None,
        bind["slot_session_id"] if bind else None,
        bind["slot_offset_min"] if bind else None,
        bind["fire_at"] if bind else None,
        _time_clear,
        data.send_to_speakers_chat,
        data.pin_in_chat,
        _nav_sent, _nav_items_param(_nav_value),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    row = dict(row)
    row["nav_items"] = _parse_nav_items(row.get("nav_items"))
    return row


@router.post("/templates/{template_id}/duplicate", summary="Дублировать шаблон")
async def duplicate_template(
    event_id: int,
    template_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Копия шаблона со ВСЕМИ настройками (текст, тайминг, аудитория, каналы, медиа).

    Зачем: сделать второе «Знакомство со спикером» — с другим текстом и другой
    аудиторией (одно интересовавшимся, второе — холодной базе), не настраивая
    тайминг заново. Копия сразу редактируется как обычный шаблон.

    ⚠️ Копируются только типы, которых на событии может быть несколько
    (custom / expert_day / speaker_intro). Остальные — один на тип: вторая копия
    просто не попала бы в генерацию (tmpl_map держит по одному на тип).
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    src = await db.fetchrow(
        "SELECT * FROM broadcast_templates WHERE id=$1 AND event_id=$2",
        template_id, event_id,
    )
    if not src:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    if src["type"] not in DUPLICABLE_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Этот шаблон можно держать только в одном экземпляре. "
                   "Дублировать можно «Знакомство со спикером», «Экспертный день» и свои шаблоны.",
        )

    row = await db.fetchrow(
        """
        INSERT INTO broadcast_templates
          (client_id, event_id, name, type, subject, text, photo_url, video_url, media_type,
           button_text, button_url, schedule_mode, offset_minutes,
           audience_include, audience_exclude, allow_custom_datetime,
           intro_start_time, intro_interval_min, intro_days_before, intro_roles,
           custom_day_ref, custom_time,
           custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at,
           target_channel_ids, send_to_event_chats, send_to_client_chats, send_to_private_chats,
           send_to_speakers_chat, speaker_photo_mode)
        SELECT client_id, event_id, $3, type, subject, text, photo_url, video_url, media_type,
               button_text, button_url, schedule_mode, offset_minutes,
               audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before, intro_roles,
               custom_day_ref, custom_time,
               custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at,
               target_channel_ids, send_to_event_chats, send_to_client_chats, send_to_private_chats,
               send_to_speakers_chat, speaker_photo_mode
          FROM broadcast_templates WHERE id=$1 AND event_id=$2
        RETURNING id, name, type, subject, text, photo_url, video_url, media_type,
                  button_text, button_url, schedule_mode, offset_minutes,
                  audience_include, audience_exclude, allow_custom_datetime,
                  intro_start_time, intro_interval_min, intro_days_before, intro_roles,
                  custom_day_ref, custom_time,
                  custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at,
                  target_channel_ids, send_to_event_chats, send_to_client_chats,
                  send_to_private_chats, send_to_speakers_chat, speaker_photo_mode, created_at
        """,
        template_id, event_id, f"{src['name']} (копия)",
    )
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

    # У коллаб-события организаторов несколько и очередь у каждого своя — от этого
    # зависит фильтр видимости ниже.
    is_collab = bool(await db.fetchval("SELECT is_collab FROM events WHERE id=$1", event_id))

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
               -- Сколько сообщений можно отозвать = записей с сохранённым message_id
               -- (TG/VK/MAX). Кнопка «Отозвать» блокируется, если 0.
               (SELECT COUNT(*) FROM broadcast_log bl WHERE bl.schedule_id = bs.id
                  AND bl.external_message_id IS NOT NULL AND bl.external_message_id <> '') as recallable_count,
               bt.name as template_name, bt.type as template_type,
               bt.schedule_mode,
               bt.text AS tmpl_text, bt.button_url AS tmpl_btn_url,   -- для проверки пустых плейсхолдеров
               cs.title as session_title,
               -- Тема выступления — чтобы раскрыть {speaker_topic} в заголовке списка.
               -- ⚠️⚠️ ДВЕ ветки, ровно как при отправке (23.09.2026). У спикерских
               -- типов (speaker_intro/expert_day/custom) `session_id` — это ec_id
               -- спикера, а НЕ слот программы: джойн `cs` для них отключён ниже, и
               -- тема всегда выходила NULL → очередь писала «тема уточняется», хотя
               -- в предпросмотре и в письме тема была. Берём её оттуда же, откуда
               -- берёт `message_builder._speaker_topics_strings` — из тем спикера.
               COALESCE(
                 NULLIF(cst.topic, ''),
                 (SELECT string_agg(NULLIF(btrim(t.topic), ''), ' · '
                                    ORDER BY t.sort_order, t.id)
                    FROM conf_speaker_topics t WHERE t.cse_id = cse_intro.id),
                 (SELECT NULLIF(btrim(t.topic), '')
                    FROM conf_speaker_topics t WHERE t.cse_id = cs.speaker_id
                   ORDER BY t.sort_order, t.id LIMIT 1),
                 cs.title
               ) AS speaker_topic_resolved,
               cs.start_time, cs.end_time,
               -- ⚠️ Дата и время выступления — для раскрытия {speaker_when} в
               -- карточке очереди (23.09.2026). Слот хранит только "HH:MM", без
               -- даты «Сегодня/Завтра» не посчитать.
               --
               -- ⚠️ Берём ИЗ СЛОТА СПИКЕРА, а не по `bs.day`: у
               -- speaker_intro/expert_day/custom `cs` не приджойнен вовсе
               -- (session_id — это ec_id спикера), а `bs.day` у них обычно
               -- пуст — проверено на проде, там NULL у всех. По дню рассылки
               -- дата не нашлась бы, и плейсхолдер остался бы пустым.
               --
               -- ⚠️ Дата и время — из ОДНОГО слота (общий ORDER BY): у спикера
               -- бывает несколько выступлений, и «дата от одного, время от
               -- другого» дали бы несуществующий момент.
               (SELECT cd.day_date
                  FROM conf_sessions cs2
                  JOIN conf_days cd ON cd.event_id = cs2.event_id
                                   AND cd.day_number = cs2.day
                 WHERE cs2.speaker_id = bs.session_id
                   AND cs2.event_id = bs.event_id
                 ORDER BY cd.day_date, cs2.start_time LIMIT 1) AS day_date_resolved,
               (SELECT cs2.start_time
                  FROM conf_sessions cs2
                  JOIN conf_days cd ON cd.event_id = cs2.event_id
                                   AND cd.day_number = cs2.day
                 WHERE cs2.speaker_id = bs.session_id
                   AND cs2.event_id = bs.event_id
                 ORDER BY cd.day_date, cs2.start_time LIMIT 1) AS intro_slot_start,
               -- ⚠️ Имя + фамилия (23.09.2026): в `collaborators.name` одно
               -- имя. Очередь рассылок показывала «Анастасия» — из двух разных
               -- не понять, чью рассылку правишь.
               CASE
                 WHEN bs.type IN ('speaker_intro', 'expert_day', 'custom')
                   THEN """ + DISPLAY_NAME_SQL("ci") + """
                 ELSE """ + DISPLAY_NAME_SQL("c") + """
               END as speaker_name,
               bs.session_id,
               bs.day,
               bs.error_log,
               -- snapshot-поля нужны фронту для правки произвольной (custom) рассылки
               bs.snapshot_text, bs.snapshot_subject, bs.snapshot_photo, bs.snapshot_video,
               -- Эффективная тема: у произвольной рассылки — своя (snapshot), у
               -- шаблонной — тема шаблона. Без этого в очереди тема шаблонных
               -- рассылок не показывалась (snapshot_subject у них пуст).
               COALESCE(NULLIF(bs.snapshot_subject, ''), bt.subject) AS eff_subject,
               bs.snapshot_media_type, bs.snapshot_buttons, bs.send_to_event_chats,
               bs.send_to_client_chats, bs.send_to_private_chats, bs.send_to_speakers_chat,
               bs.target_channel_ids,
               bs.chats_overridden,
               -- Эффективные каналы/флаги: schedule → иначе значения шаблона (как при отправке).
               -- ⚠️ Если chats_overridden=TRUE — берём СТРОГО из рассылки (шаблон не
               -- подмешиваем, как в движке tasks/broadcast.py), иначе OR с шаблоном.
               COALESCE(bs.target_channel_ids, bt.target_channel_ids) AS eff_target_channel_ids,
               (bs.send_to_event_chats OR (NOT bs.chats_overridden AND COALESCE(bt.send_to_event_chats, FALSE))) AS eff_send_to_event_chats,
               (bs.send_to_client_chats OR (NOT bs.chats_overridden AND COALESCE(bt.send_to_client_chats, FALSE))) AS eff_send_to_client_chats,
               (bs.send_to_private_chats OR (NOT bs.chats_overridden AND COALESCE(bt.send_to_private_chats, FALSE))) AS eff_send_to_private_chats,
               (bs.send_to_speakers_chat OR (NOT bs.chats_overridden AND COALESCE(bt.send_to_speakers_chat, FALSE))) AS eff_send_to_speakers_chat,
               -- Закреп: по той же схеме наследования, чтобы в очереди было
               -- видно, что сообщение не просто уйдёт в чат, но и встанет в закреп.
               (bs.pin_in_chat OR (NOT bs.chats_overridden AND COALESCE(bt.pin_in_chat, FALSE))) AS eff_pin_in_chat
        FROM broadcast_schedules bs
        LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
        -- speaker_intro/expert_day/custom: session_id = event_collaborators.id (спикер),
        -- у остальных session_id = conf_sessions.id (сессия программы).
        -- ⚠️ 'custom' — в «спикерской» ветке: и ручная произвольная рассылка, и
        -- шаблон с привязкой к слоту (миграция 260) пишут туда именно ec_id.
        LEFT JOIN conf_sessions cs ON cs.id = bs.session_id AND bs.type NOT IN ('speaker_intro', 'expert_day', 'custom')
        LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
        LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
        LEFT JOIN collaborators c ON c.id = cse.speaker_id
        LEFT JOIN event_collaborators cse_intro ON cse_intro.id = bs.session_id AND bs.type IN ('speaker_intro', 'expert_day', 'custom')
        LEFT JOIN collaborators ci ON ci.id = cse_intro.speaker_id
        WHERE bs.event_id = $1
          -- Кто какие рассылки видит.
          -- КОЛЛАБА ($3=TRUE): строго свои (client_id=я). Очередь у каждого
          -- организатора своя — он рассылает по своей базе через своего бота, и
          -- чужие рассылки ему не нужны и не управляемы. Записи с client_id IS NULL
          -- (авто-сгенерированные до этой правки) тоже скрываем: непонятно, чьи они,
          -- а движок отправки увёл бы их на «первого владельца» — то есть по чужой базе.
          -- ОБЫЧНОЕ событие: владелец один, NULL — норма (так создаёт генерация),
          -- поведение оставлено прежним.
          AND (
            CASE WHEN $3 THEN bs.client_id = $2
                 ELSE (bs.client_id IS NULL OR bs.client_id = $2) END
          )
        -- ⚠️ NULLS FIRST — см. тот же комментарий в broadcasts_general.py:
        -- копия без даты должна быть сверху, а не теряться в конце очереди.
        ORDER BY bs.fire_at NULLS FIRST
        """,
        event_id, client_id, is_collab
    )

    # Часовой пояс клиента для отображения
    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz_str = (client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow"
    tz = ZoneInfo(tz_str)

    now_utc = datetime.utcnow().replace(tzinfo=ZoneInfo("UTC"))

    # Для проверки «пустых» плейсхолдеров ({stream_url}/{support}) в рассылке:
    # есть ли у клиента хоть один контакт поддержки + у каких дней есть вебинар-комната.
    from app.services.support_message import has_support
    _sup_row = await db.fetchrow(
        "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id=$1", client_id)
    _has_support = has_support(
        _sup_row["work_tg_username"] if _sup_row else None,
        _sup_row["work_vk"] if _sup_row else None,
        _sup_row["work_max"] if _sup_row else None)
    _rooms_rows = await db.fetch(
        "SELECT day_number FROM webinar_rooms WHERE event_id=$1", event_id)
    _days_with_room = {rr["day_number"] for rr in _rooms_rows}
    _any_room = bool(_days_with_room)
    # {support_command} (кнопка «Тех.поддержка») работает только если у клиента
    # есть свой бот хоть на одной площадке (deeplink строится по handle).
    from app.services.share_links import get_client_bot_handles as _get_handles
    _handles = await _get_handles(db, client_id)
    _any_bot = any(_handles.get(_p) for _p in ("telegram", "vk", "max"))

    def _when_for_card(d: dict) -> str:
        """«Сегодня/Завтра в HH:MM МСК» для карточки очереди.

        ⚠️ Тем же хелпером, что и отправка (`message_builder.relative_when`):
        своя копия формата разошлась бы с тем, что реально уйдёт человеку.
        ⚠️ Точка отсчёта — дата ОТПРАВКИ (`fire_at`, МСК), а не «сейчас»:
        рассылка, назначенная на завтра, должна говорить «Сегодня» глазами
        того, кто получит её завтра.
        ⚠️ Нет даты или времени → пустая строка: плейсхолдер исчезнет, как и
        при отправке, а не останется сырым.
        """
        from app.services.message_builder import relative_when, _msk_ref_date
        hhmm = d.get("start_time") or d.get("intro_slot_start")
        return relative_when(d.get("day_date_resolved"), hhmm,
                             _msk_ref_date(d.get("fire_at"))) or ""

    def _empty_placeholder_reason(text, btn, day):
        """Причина, почему рассылку нельзя ставить в очередь (пустой плейсхолдер), или None."""
        blob = f"{text or ''} {btn or ''}"
        # {support*} — нет ни одного контакта поддержки
        if ("{support_platform}" in blob or "{support_link}" in blob or "{support_links}" in blob) and not _has_support:
            return "Плейсхолдер службы поддержки пуст — не задан ни один контакт (Telegram/VK/MAX) в Настройках → Профиль"
        # {support_command} — нет своего бота ни на одной площадке
        if "{support_command}" in blob and not _any_bot:
            return "Кнопка «Тех.поддержка» ({support_command}) не сработает — не подключён свой бот ни на одной площадке (раздел «Каналы»)"
        # {stream_url} — нет вебинарной комнаты у нужного дня
        if "{stream_url}" in blob:
            if day is not None:
                if day not in _days_with_room:
                    return f"{{stream_url}} пуст — у дня {day} нет вебинарной комнаты (создайте в разделе «Вебинары»)"
            elif not _any_room:
                return "{stream_url} пуст — у события нет ни одной вебинарной комнаты"
        return None

    result = []
    import json as _json_list
    for r in rows:
        d = dict(r)
        # Проверка пустых обязательных плейсхолдеров → фронт красит + блокирует запуск.
        _txt = r.get("snapshot_text") or r.get("tmpl_text") or ""
        _btn = r.get("snapshot_btn_url") if "snapshot_btn_url" in r else r.get("tmpl_btn_url")
        _reason = _empty_placeholder_reason(_txt, _btn or "", r.get("day"))
        d["empty_placeholder_reason"] = _reason
        d["has_empty_placeholder"] = bool(_reason)
        # Раскрываем {speaker_topic}/{speaker_name} в ЗАГОЛОВКЕ карточки очереди —
        # чтобы в слепке была тема, а не сырой плейсхолдер (в превью/отправке уже норм).
        if d.get("eff_subject"):
            _subj = d["eff_subject"]
            if "{speaker_topic}" in _subj:
                _subj = _subj.replace("{speaker_topic}", (d.get("speaker_topic_resolved") or "").strip() or "тема уточняется")
            if "{speaker_name}" in _subj:
                _subj = _subj.replace("{speaker_name}", (d.get("speaker_name") or "").strip())
            if "{speaker_when}" in _subj:
                _subj = _subj.replace("{speaker_when}", _when_for_card(d))
            d["eff_subject"] = _subj
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

    # «Сейчас» в UTC — все fire_at ниже приводятся к UTC, поэтому сравниваем с ним.
    # Рассылки с уже прошедшим временем не создаём (кнопка «Сформировать из программы»
    # не должна плодить прошедшие даты). Люфт _PAST_GRACE_MIN — как в ручных ручках.
    now_utc = datetime.now(ZoneInfo("UTC"))
    past_cutoff = now_utc - timedelta(minutes=_PAST_GRACE_MIN)

    # Тип события + дата старта (для мероприятий)
    ev_row = await db.fetchrow(
        "SELECT module_slug, start_at, end_at, is_collab FROM events WHERE id=$1",
        event_id
    )
    is_conf = ev_row and ev_row["module_slug"] == "conference"
    is_turnir = ev_row and ev_row["module_slug"] == "turnir"
    event_start_at = ev_row["start_at"] if ev_row else None
    event_end_at = ev_row["end_at"] if ev_row else None
    is_collab = bool(ev_row and ev_row["is_collab"])

    # ⚠️ У КОЛЛАБ-события каждый организатор ведёт СВОЮ базу через СВОЙ бот, поэтому
    # авто-сгенерированные рассылки обязаны принадлежать тому, кто нажал «Сформировать»:
    # с client_id=NULL движок отправки (tasks/broadcast.py) падает на «первого владельца»
    # из event_owners, и рассылка ушла бы по чужой базе через чужой бот. Плюс в очереди
    # такая запись была бы видна всем организаторам сразу.
    # У обычного события владелец один — оставляем NULL, как было (совместимость).
    gen_client_id = client_id if is_collab else None

    async def _dup_exists(sql: str, *args):
        """
        Проверка «такая рассылка уже создана».

        У КОЛЛАБЫ дедуп обязан быть В ГРАНИЦАХ СВОЕЙ базы: очередь у каждого
        организатора своя, и записи первого не должны схлопывать генерацию у
        второго — иначе он нажмёт «Сформировать» и получит пустую очередь.
        У обычного события владелец один: дедупим по всему событию, как раньше.
        """
        if is_collab:
            sql += f" AND client_id IS NOT DISTINCT FROM ${len(args) + 1}"
            args = (*args, gen_client_id)
        return await db.fetchval(sql, *args)

    # «Событие с программой по дням» — конференция или турнир, у которого
    # есть дни программы (conf_days). Тогда дневные рассылки (2h/30min) считаем
    # по первой сессии каждого дня, а не от единой events.start_at.
    has_conf_days = await db.fetchval(
        "SELECT 1 FROM conf_days WHERE event_id=$1 LIMIT 1", event_id
    )
    use_day_program = bool(is_conf or (is_turnir and has_conf_days))

    # Рассылка спикерам «вы следующие» — под фичей (миграция 438). Считаем один
    # раз на весь прогон: внутри цикла по слотам это был бы запрос на каждый слот.
    from app.services.features import client_has_feature as _has_feat
    speakers_call_allowed = await _has_feat(db, client_id, "speakers_call")

    templates = await db.fetch(
        """
        SELECT id, type, schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime,
               intro_start_time, intro_interval_min, intro_days_before,
               custom_day_ref, custom_time,
               custom_bind_kind, custom_slot_session_id, custom_slot_offset_min, custom_fire_at,
               text, photo_url, button_text, button_url,
               name, send_to_event_chats, send_to_client_chats, send_to_private_chats,
               send_to_speakers_chat, intro_roles, pin_in_chat, nav_items
        FROM broadcast_templates WHERE event_id=$1
        """,
        event_id
    )
    # Фильтр по выбранным галочками шаблонам (если передан template_ids).
    only_ids = set(data.template_ids) if (data and data.template_ids is not None) else None
    if only_ids is not None:
        templates = [t for t in templates if t["id"] in only_ids]

    # Для предустановленных типов — один шаблон на тип. Кастомные, expert_day и
    # speaker_intro (их может быть несколько на событие) собираем отдельно.
    # ⚠️ speaker_intro стал многоэкземплярным (копия шаблона): клиент делает
    # второе «Знакомство» с другим текстом и другой аудиторией (например одно —
    # интересовавшимся с соцсетями, второе — холодной базе без соцсетей).
    tmpl_map = {t["type"]: t for t in templates
                if t["type"] not in ("custom", "expert_day", "speaker_intro")}
    custom_tmpls = [t for t in templates if t["type"] == "custom"]
    expert_day_tmpls = [t for t in templates if t["type"] == "expert_day"]
    speaker_intro_tmpls = [t for t in templates if t["type"] == "speaker_intro"]

    if not tmpl_map and not custom_tmpls and not expert_day_tmpls and not speaker_intro_tmpls:
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

    # day — номер дня программы, к которому относится дневная рассылка. Пишем его
    # ЯВНО, чтобы message_builder не гадал по дате fire_at (для «за сутки» дата
    # отправки — накануне, и по ней день не определить).
    async def add_schedule(tmpl, fire_at, session_id=None, sched_type=None, day=None):
        nonlocal created, skipped
        t = sched_type or tmpl["type"]
        # Не создаём рассылки с уже прошедшим временем отправки.
        if fire_at is not None and fire_at < past_cutoff:
            skipped += 1
            return
        if session_id:
            # Для спикерских рассылок — дубль по session_id + type
            exists = await _dup_exists(
                """SELECT 1 FROM broadcast_schedules
                   WHERE event_id=$1 AND template_id=$2 AND session_id=$3 AND type=$4""",
                event_id, tmpl["id"], session_id, t
            )
        else:
            # Для дневных рассылок — дубль по fire_at + type (каждый день имеет своё время)
            exists = await _dup_exists(
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
              (event_id, session_id, template_id, type, fire_at, day, status, audience_include, audience_exclude,
               snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id,
               send_to_speakers_chat, send_to_event_chats, pin_in_chat, nav_items)
            VALUES ($1, $2, $3, $4, $5, $12, 'draft', $6, $7, $8, $9, $10, $11, $13, $14, $15, $16, $17)
            """,
            event_id, session_id, tmpl["id"], t, fire_at,
            tmpl["audience_include"], tmpl["audience_exclude"],
            tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
            day, gen_client_id,
            # Пишем флаг в саму запись, а не полагаемся только на наследование от
            # шаблона: в очереди по нему рисуется плашка «в чат спикеров», и она
            # должна быть видна сразу после «Сформировать из программы».
            bool(tmpl.get("send_to_speakers_chat")),
            # То же для навигации по чату: в очереди видно, что рассылка уйдёт
            # в чат и будет закреплена, а пункты — снимок на момент постановки.
            bool(tmpl.get("send_to_event_chats")),
            bool(tmpl.get("pin_in_chat")),
            _nav_items_param(tmpl.get("nav_items")),
        )
        created += 1

    # Получаем первый день конференции (нужен для pre_conf и speaker_intro)
    first_day = await db.fetchrow(
        "SELECT day_date FROM conf_days WHERE event_id=$1 ORDER BY day_date NULLS LAST, day_number LIMIT 1",
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
            _h, _m = _tmpl_time_msk(tmpl, 10, 43)
            fire_at_pre_conf = datetime(send_date.year, send_date.month, send_date.day, _h, _m, 0, tzinfo=tz_msk)
            exists = await _dup_exists(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='pre_conf'",
                event_id
            )
            if fire_at_pre_conf < past_cutoff:
                skipped += 1
            elif not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
                    VALUES ($1, NULL, $2, 'pre_conf', $3, 'draft', $4, $5, $6, $7, $8, $9, $10)
                    """,
                    event_id, tmpl["id"], fire_at_pre_conf,
                    tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
                    gen_client_id
                )
                created += 1
            else:
                skipped += 1
        else:
            # Нет даты дня — создаём без времени
            exists = await _dup_exists(
                "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='pre_conf'",
                event_id
            )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
                    VALUES ($1, NULL, $2, 'pre_conf', NULL, 'draft', $3, $4, $5, $6, $7, $8, $9)
                    """,
                    event_id, tmpl["id"],
                    tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
                    gen_client_id
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
            # ⚠️ Время старта берём из шаблона (intro_start_time, «ЧЧ:ММ»).
            # Раньше было зашито 10:48, и задать своё было негде — рассылки
            # формировались не в то время, а прошедшие молча пропускались.
            _hh, _mm = 10, 48
            _raw = (tmpl.get("intro_start_time") or "").strip()
            if _raw:
                try:
                    _parts = _raw.split(":")
                    _hh, _mm = int(_parts[0]), int(_parts[1])
                except (ValueError, IndexError):
                    _hh, _mm = 10, 48   # мусор в поле не должен ломать генерацию
            base_dt = datetime(start_date.year, start_date.month, start_date.day,
                               _hh, _mm, 0, tzinfo=tz_msk)

            for i, sp in enumerate(speakers_list):
                fire_at = base_dt + timedelta(minutes=interval_min * i)
                # Не создаём рассылки с уже прошедшим временем отправки.
                if fire_at < past_cutoff:
                    skipped += 1
                    continue
                # expert_day может быть несколько шаблонов на событие — дедупим ещё
                # и по template_id, чтобы разные «Экспертные дни» не схлопывались.
                if per_template_dedup:
                    exists = await _dup_exists(
                        """SELECT 1 FROM broadcast_schedules
                           WHERE event_id=$1 AND type=$2 AND session_id=$3 AND template_id=$4""",
                        event_id, b_type, sp["id"], tmpl["id"]
                    )
                else:
                    exists = await _dup_exists(
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
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
                    VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11, $12)
                    """,
                    event_id, sp["id"], tmpl["id"], b_type, fire_at,
                    tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
                    gen_client_id
                )
                created += 1
        else:
            # Нет дней или коллабов — создаём одну запись без времени.
            if per_template_dedup:
                exists = await _dup_exists(
                    "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type=$2 AND session_id IS NULL AND template_id=$3",
                    event_id, b_type, tmpl["id"]
                )
            else:
                exists = await _dup_exists(
                    "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type=$2 AND session_id IS NULL",
                    event_id, b_type
                )
            if not exists:
                await db.execute(
                    """
                    INSERT INTO broadcast_schedules
                      (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                       snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
                    VALUES ($1, NULL, $2, $3, NULL, 'draft', $4, $5, $6, $7, $8, $9, $10)
                    """,
                    event_id, tmpl["id"], b_type, tmpl["audience_include"], tmpl["audience_exclude"],
                    tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
                    gen_client_id
                )
                created += 1
            else:
                skipped += 1

    # ── speaker_intro: одна запись на каждого спикера — начиная через 5 мин после pre_conf ──
    # Копий «Знакомства» может быть несколько → дедуп по template_id (как expert_day),
    # иначе вторая копия схлопнулась бы с первой (дедуп по type+session_id).
    _multi_intro = len(speaker_intro_tmpls) > 1
    for _si_tmpl in speaker_intro_tmpls:
        await _fanout_collaborator_intro(_si_tmpl, per_template_dedup=_multi_intro)

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

        # «Вы следующие» — в ЧАТ СПИКЕРОВ за 15 минут до выступления (миграция 432).
        # Отдельная запись на каждый слот: у каждого спикера свой сигнал.
        # ⚠️ Под фичей: шаблон мог остаться у события с тех пор, когда фича была
        # (или её выключили) — тогда в очередь он больше не становится.
        if "speakers_call" in tmpl_map and s_start_utc and speakers_call_allowed:
            tmpl = tmpl_map["speakers_call"]
            offset = tmpl["offset_minutes"] or 15
            await add_schedule(tmpl, s_start_utc - timedelta(minutes=offset), s["id"], "speakers_call")

    # ── Дневные рассылки — на КАЖДЫЙ день программы (конференция/турнир) ──
    # Точка отсчёта дня = первая сессия этого дня. Номер дня пишем явно (day=),
    # чтобы в сообщение попала программа именно этого дня.
    tz_msk = ZoneInfo("Europe/Moscow")
    for day_num, day_sessions in days.items():
        first_session = day_sessions[0]
        last_session = day_sessions[-1]
        first_start_utc = _msk_str_to_utc(first_session.get("day_date"), first_session.get("start_time"))
        last_end_utc    = _msk_str_to_utc(last_session.get("day_date"),  last_session.get("end_time"))

        for ttype in ("2h_before_unreg", "2h_before_reg", "30min_before"):
            if ttype in tmpl_map and first_start_utc:
                tmpl = tmpl_map[ttype]
                offset = tmpl["offset_minutes"] or 30
                await add_schedule(tmpl, first_start_utc - timedelta(minutes=offset), None, ttype, day=day_num)

        if "day_live" in tmpl_map and first_start_utc:
            tmpl = tmpl_map["day_live"]
            offset = tmpl["offset_minutes"] or 5
            await add_schedule(tmpl, first_start_utc - timedelta(minutes=offset), None, "day_live", day=day_num)

        # Программа дня В ЧАТ СПИКЕРОВ — накануне (миграция 442). Своя запись
        # на каждый день: у трёхдневной конференции три напоминания.
        # ⚠️ Под той же фичей, что и «вы следующие»: обе рассылки служебные,
        # и шаблон мог остаться у события с тех пор, когда фича была включена.
        # ⚠️ Объявляем ДО блока: на него смотрит инструкция ниже, а шаблона
        # программы у события может не быть вовсе — иначе NameError.
        _sp_fire = None
        if "speakers_day" in tmpl_map and first_start_utc and speakers_call_allowed:
            tmpl = tmpl_map["speakers_day"]
            # 1440 минут = сутки. Если клиент задал в шаблоне своё время
            # (intro_start_time, «HH:MM» МСК) — шлём накануне в этот час:
            # «за сутки до 10:30» попадает на 10:30 предыдущего дня, а команде
            # удобнее получать тайминг вечером или утром — по их выбору.
            _sp_raw = ""
            try:
                _sp_raw = (tmpl["intro_start_time"] or "").strip()
            except (KeyError, TypeError):
                _sp_raw = ""
            if _sp_raw:
                _h, _m = _tmpl_time_msk(tmpl, 0, 0)
                _prev_date = first_session.get("day_date")
                # ⚠️ «За сколько дней» берём из `intro_days_before`, а не всегда
                # сутки (23.09.2026). Раньше здесь стояло жёсткое `days=1`, и
                # настройки в интерфейсе не было вовсе — поправить время
                # отправки было нечем. 0 = в сам день программы.
                _days = tmpl["intro_days_before"] if "intro_days_before" in tmpl else None
                try:
                    _days = int(_days) if _days is not None else 1
                except (TypeError, ValueError):
                    _days = 1
                _days = max(0, min(30, _days))
                _sp_fire = (_msk_str_to_utc(_prev_date, f"{_h:02d}:{_m:02d}") - timedelta(days=_days)
                            if _prev_date else None)
            else:
                _sp_fire = first_start_utc - timedelta(minutes=tmpl["offset_minutes"] or 1440)
            if _sp_fire:
                await add_schedule(tmpl, _sp_fire, None, "speakers_day", day=day_num)

        # ── Инструкция по подключению — СЛЕДОМ за программой дня ──────────
        # ⚠️ Через минуту после программы, а не в своё время: два сообщения
        # подряд в одном чате, инструкция второй. Сначала «во сколько я», потом
        # «куда заходить» — обратный порядок читается как инструкция в пустоту.
        # Своё время клиент может задать в настройках шаблона, тогда берём его.
        if "speakers_howto" in tmpl_map and first_start_utc and speakers_call_allowed:
            tmpl = tmpl_map["speakers_howto"]
            _hw_raw = ""
            try:
                _hw_raw = (tmpl["intro_start_time"] or "").strip()
            except (KeyError, TypeError):
                _hw_raw = ""
            if _hw_raw:
                # Клиент задал своё время — считаем как у программы дня.
                _h, _m = _tmpl_time_msk(tmpl, 0, 0)
                _prev_date = first_session.get("day_date")
                _days = tmpl["intro_days_before"] if "intro_days_before" in tmpl else None
                try:
                    _days = int(_days) if _days is not None else 1
                except (TypeError, ValueError):
                    _days = 1
                _days = max(0, min(30, _days))
                _hw_fire = (_msk_str_to_utc(_prev_date, f"{_h:02d}:{_m:02d}") - timedelta(days=_days)
                            if _prev_date else None)
            elif _sp_fire:
                # Времени своего нет → ровно через минуту после программы.
                _hw_fire = _sp_fire + timedelta(minutes=1)
            else:
                _hw_fire = first_start_utc - timedelta(minutes=tmpl["offset_minutes"] or 1439)
            if _hw_fire:
                await add_schedule(tmpl, _hw_fire, None, "speakers_howto", day=day_num)

        if "day_end" in tmpl_map:
            tmpl = tmpl_map["day_end"]
            # Время отправки итогов дня: либо ЯВНОЕ из шаблона (intro_start_time,
            # «HH:MM» МСК того же дня), либо, как раньше, конец последней сессии
            # + offset. ⚠️ Без явного времени рассылку было не сформировать, если
            # день уже идёт: расчётное «конец + 30 мин» оказывалось в прошлом и
            # add_schedule молча пропускал запись.
            _raw_time = ""
            try:
                _raw_time = (tmpl["intro_start_time"] or "").strip()
            except (KeyError, TypeError):
                _raw_time = ""
            if _raw_time:
                _h, _m = _tmpl_time_msk(tmpl, 0, 0)
                _fire = _msk_str_to_utc(last_session.get("day_date"), f"{_h:02d}:{_m:02d}")
            else:
                _fire = (last_end_utc + timedelta(minutes=tmpl["offset_minutes"] or 30)
                         if last_end_utc else None)
            if _fire:
                await add_schedule(tmpl, _fire, None, "day_end", day=day_num)

        # «За сутки в 09:12 МСК» — тоже на КАЖДЫЙ день программы (раньше создавалась
        # одна запись на всё событие, по первому дню). Отправка накануне дня в 09:12,
        # содержимое — программа дня day_num.
        if first_start_utc:
            day_before_date = first_start_utc.astimezone(tz_msk).date() - timedelta(days=1)
            for ttype in ("day_before_09_12_unreg", "day_before_09_12_reg"):
                if ttype in tmpl_map:
                    _h, _m = _tmpl_time_msk(tmpl_map[ttype], 9, 12)
                    _fire = datetime(day_before_date.year, day_before_date.month,
                                     day_before_date.day, _h, _m, 0,
                                     tzinfo=tz_msk).astimezone(ZoneInfo("UTC"))
                    await add_schedule(tmpl_map[ttype], _fire, None, ttype, day=day_num)

    # ⚠️ `event_live` («за 5 минут до старта мероприятия») у события С ПРОГРАММОЙ
    # НЕ генерируется — это дубль `day_live` («старт дня»), который уходит перед
    # КАЖДЫМ днём программы. event_live — только для мероприятий без дней
    # (точка отсчёта events.start_at), см. блок ниже.

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
        for ttype in ("day_before_09_12_unreg", "day_before_09_12_reg"):
            if ttype in tmpl_map:
                _h, _m = _tmpl_time_msk(tmpl_map[ttype], 9, 12)
                _fire = datetime(day_before.year, day_before.month, day_before.day,
                                 _h, _m, 0, tzinfo=tz_msk).astimezone(ZoneInfo("UTC"))
                await add_schedule(tmpl_map[ttype], _fire, None, ttype)

    # ── vip_offer: одна запись на событие с fire_at=NULL (пользователь сам задаёт время) ──
    if "vip_offer" in tmpl_map:
        tmpl = tmpl_map["vip_offer"]
        exists = await _dup_exists(
            "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='vip_offer' AND session_id IS NULL",
            event_id
        )
        if not exists:
            await db.execute(
                """
                INSERT INTO broadcast_schedules
                  (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
                VALUES ($1, NULL, $2, 'vip_offer', NULL, 'draft', $3, $4, $5, $6, $7, $8, $9)
                """,
                event_id, tmpl["id"], tmpl["audience_include"], tmpl["audience_exclude"],
                tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
                gen_client_id
            )
            created += 1
        else:
            skipped += 1

    # ── chat_nav: навигация по чату, время задаёт клиент (как vip_offer) ───
    # Пост-навигация не привязана к программе: её вешают в чат один раз, когда
    # чат наполнился. Поэтому fire_at=NULL — рассылка ждёт в очереди, пока
    # клиент не поставит время.
    if "chat_nav" in tmpl_map:
        tmpl = tmpl_map["chat_nav"]
        exists = await _dup_exists(
            "SELECT 1 FROM broadcast_schedules WHERE event_id=$1 AND type='chat_nav' AND session_id IS NULL",
            event_id
        )
        if not exists:
            await db.execute(
                """
                INSERT INTO broadcast_schedules
                  (event_id, session_id, template_id, type, fire_at, status, audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id,
                   send_to_event_chats, pin_in_chat, nav_items)
                VALUES ($1, NULL, $2, 'chat_nav', NULL, 'draft', $3, $4, $5, $6, $7, $8, $9,
                        $10, $11, $12)
                """,
                event_id, tmpl["id"], tmpl["audience_include"], tmpl["audience_exclude"],
                tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
                gen_client_id,
                bool(tmpl.get("send_to_event_chats")), bool(tmpl.get("pin_in_chat")),
                _nav_items_param(tmpl.get("nav_items")),
            )
            created += 1
        else:
            skipped += 1

    # ── Кастомные шаблоны ──────────────────────────────────────────────────
    # Три режима привязки (custom_bind_kind, миграция 260):
    #   'day' (и NULL — как было до 260) — день программы (custom_day_ref) + custom_time;
    #   'slot' — слот спикера: fire_at = старт слота + смещение, в schedule пишется
    #            session_id спикера (event_collaborators.id) → в сообщении работают
    #            {speaker_name}, {speaker_time}, {speaker_topic}, афиша спикера;
    #   'none' — абсолютные дата+время (custom_fire_at), без привязки к программе.
    if custom_tmpls:
        tz = await _client_tz(db, client_id)

        conf_days_list = await db.fetch(
            "SELECT day_number, day_date FROM conf_days WHERE event_id=$1 ORDER BY day_date NULLS LAST, day_number",
            event_id
        )
        first_day_row = conf_days_list[0] if conf_days_list else None
        last_day_row = conf_days_list[-1] if conf_days_list else None
        days_by_num = {d["day_number"]: d["day_date"] for d in conf_days_list}

        for tmpl in custom_tmpls:
            kind = (tmpl["custom_bind_kind"] or "day").strip().lower()
            fire_at = None
            sched_session_id = None
            sched_day = None

            if kind == "none":
                fire_at = tmpl["custom_fire_at"]
                if not fire_at:
                    skipped += 1
                    continue

            elif kind == "slot":
                slot = await db.fetchrow(
                    """
                    SELECT cs.day, cs.start_time, cs.speaker_id, cd.day_date
                      FROM conf_sessions cs
                      LEFT JOIN conf_days cd
                        ON cd.event_id = cs.event_id AND cd.day_number = cs.day
                     WHERE cs.id = $1 AND cs.event_id = $2
                    """,
                    tmpl["custom_slot_session_id"], event_id,
                )
                # Слот удалили из программы или у него нет даты/времени — пропускаем.
                if not slot or not slot["day_date"] or not slot["start_time"]:
                    skipped += 1
                    continue
                start_utc = _msk_str_to_utc(slot["day_date"], slot["start_time"])
                if not start_utc:
                    skipped += 1
                    continue
                fire_at = start_utc + timedelta(minutes=int(tmpl["custom_slot_offset_min"] or 0))
                # session_id = event_collaborators.id спикера слота: именно по нему
                # message_builder раскрывает спикерские плейсхолдеры произвольной рассылки.
                sched_session_id = slot["speaker_id"]
                sched_day = slot["day"]

            else:  # 'day' — прежнее поведение
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
                    sched_day = n if target_date else None
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

            # Не создаём рассылки с уже прошедшим временем отправки.
            if fire_at < past_cutoff:
                skipped += 1
                continue

            exists = await _dup_exists(
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
                  (event_id, session_id, template_id, type, fire_at, day, status,
                   audience_include, audience_exclude,
                   snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
                VALUES ($1, $10, $2, 'custom', $3, $11, 'draft', $4, $5, $6, $7, $8, $9, $12)
                """,
                event_id, tmpl["id"], fire_at,
                tmpl["audience_include"], tmpl["audience_exclude"],
                tmpl.get("text"), tmpl.get("photo_url"), tmpl.get("button_text"), tmpl.get("button_url"),
                sched_session_id, sched_day, gen_client_id,
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
    # Закреп и пункты навигации — по тому же принципу «снимок от шаблона».
    # ⚠️ Пункты копируем КАЖДОМУ шаблону отдельно: они у каждого свои, одним
    # UPDATE по списку id их не проставить.
    for t in templates:
        if t.get("pin_in_chat"):
            await db.execute(
                """UPDATE broadcast_schedules SET pin_in_chat = TRUE
                    WHERE event_id = $1 AND template_id = $2""",
                event_id, t["id"],
            )
        if t.get("nav_items"):
            await db.execute(
                """UPDATE broadcast_schedules SET nav_items = $3::jsonb
                    WHERE event_id = $1 AND template_id = $2 AND nav_items IS NULL""",
                event_id, t["id"], _nav_items_param(t["nav_items"]),
            )

    return {"ok": True, "created": created, "skipped": skipped}


# ─────────────────────────────────────────
# Сдвиг тайминга спикерских рассылок внутри одного дня программы
#
# Типы, которые сдвигаются: «за 5 минут до выступления» (5min_before) и
# «подарок после эфира» (gift). Оба привязаны к conf_sessions.id (сессия
# программы), поэтому «день» берём из программы (conf_sessions.day →
# conf_days.day_date), а НЕ из календарной даты fire_at: подарок последнего
# выступления может уехать за полночь, но принадлежит своему дню.
#
# Сдвигаются только рассылки, которые ещё не ушли: draft / pending.
# ─────────────────────────────────────────
# speakers_call («вы следующие» в чат спикеров) тоже привязан к старту слота —
# сдвигаем вместе с ним, иначе спикера позовут в старое время.
SHIFTABLE_TYPES = ("5min_before", "gift", "speakers_call")


async def _shiftable_sessions(db, event_id: int, day_number: int):
    """Спикеры дня, у которых есть несданные 5min_before/gift, по времени старта."""
    return await db.fetch(
        """
        SELECT cs.id            AS session_id,
               cs.start_time,
               cs.end_time,
               COALESCE(NULLIF(cst.topic,''), cs.title) AS session_title,
               """ + DISPLAY_NAME_SQL("c") + """ AS speaker_name,  -- имя + фамилия (23.09.2026)
               COUNT(bs.id)     AS schedules_count,
               -- Сколько из них уйдёт В ЧАТ СПИКЕРОВ. Нужно фронту, чтобы
               -- пометить таких спикеров в списке сдвига: клиент правит тайминг
               -- участниковых и не думает про команду, а её позовут в новое время.
               COUNT(bs.id) FILTER (WHERE bs.type = 'speakers_call') AS speakers_chat_count,
               MIN(bs.fire_at)  AS first_fire_at
        FROM conf_sessions cs
        JOIN broadcast_schedules bs
             ON bs.session_id = cs.id
            AND bs.event_id = cs.event_id
            AND bs.type = ANY($3::text[])
            AND bs.status IN ('draft', 'pending')
        LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
        LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
        LEFT JOIN collaborators c ON c.id = cse.speaker_id
        WHERE cs.event_id = $1 AND cs.day = $2 AND cs.speaker_id IS NOT NULL
        GROUP BY cs.id, cs.start_time, cs.end_time, cst.topic, cs.title, c.name
        ORDER BY cs.start_time NULLS LAST, cs.id
        """,
        event_id, day_number, list(SHIFTABLE_TYPES),
    )


@router.get("/schedules/shift-speakers", summary="Спикеры дня, чьи рассылки можно сдвинуть")
async def list_shift_speakers(
    event_id: int,
    day: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    rows = await _shiftable_sessions(db, event_id, day)

    client_row = await db.fetchrow("SELECT timezone FROM clients WHERE id=$1", client_id)
    tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")

    speakers = []
    for r in rows:
        d = dict(r)
        # Время программы — строки "HH:MM" (см. правило «Время программы — строки HH:MM»).
        d["start_time"] = str(r["start_time"])[:5] if r["start_time"] else None
        d["end_time"] = str(r["end_time"])[:5] if r["end_time"] else None
        d["schedules_count"] = int(r["schedules_count"])
        d["first_fire_at_local"] = (
            r["first_fire_at"].astimezone(tz).strftime("%d.%m.%Y %H:%M") if r["first_fire_at"] else None
        )
        d.pop("first_fire_at", None)
        speakers.append(d)

    return {"speakers": speakers, "day": day}


class ShiftTimingRequest(BaseModel):
    day: int                # номер дня программы (conf_days.day_number)
    from_session_id: int    # с какого спикера начинать сдвиг (включительно)
    minutes: int            # на сколько минут сдвинуть (может быть отрицательным)


@router.post("/schedules/shift-timing", summary="Сдвинуть спикерские рассылки дня")
async def shift_timing(
    event_id: int,
    data: ShiftTimingRequest,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)

    if data.minutes == 0:
        raise HTTPException(status_code=400, detail="Сдвиг на 0 минут ничего не изменит")

    rows = await _shiftable_sessions(db, event_id, data.day)
    if not rows:
        raise HTTPException(
            status_code=400,
            detail="В этот день нет рассылок «за 5 минут до выступления» или «подарок после эфира» — сдвигать нечего"
        )

    ordered_ids = [r["session_id"] for r in rows]
    if data.from_session_id not in ordered_ids:
        raise HTTPException(status_code=400, detail="У выбранного спикера нет рассылок этого дня")

    # Все спикеры начиная с выбранного и до конца дня (порядок — по времени старта).
    start_idx = ordered_ids.index(data.from_session_id)
    target_session_ids = ordered_ids[start_idx:]

    # Время старта выбранного слота — от него двигаем и саму программу.
    from_start_time = rows[start_idx]["start_time"]

    # Слоты программы, которые двигаем вместе с рассылками: ВСЕ слоты этого дня,
    # начинающиеся не раньше выбранного — включая те, у которых нет рассылок
    # (партнёрские вставки, «тема уточняется»). Иначе программа разъедется.
    program_rows = await db.fetch(
        """SELECT id, start_time, end_time
             FROM conf_sessions
            WHERE event_id = $1 AND day = $2
              AND start_time IS NOT NULL AND start_time >= $3
            ORDER BY start_time, sort_order, id""",
        event_id, data.day, from_start_time,
    ) if from_start_time else []

    def _shift_hhmm(hhmm, delta: int):
        """Сдвиг "HH:MM" на delta минут. Через полночь не переносим — упираемся в границы суток."""
        if not hhmm:
            return None
        h, m = map(int, str(hhmm)[:5].split(":"))
        total = max(0, min(h * 60 + m + delta, 23 * 60 + 59))
        return f"{total // 60:02d}:{total % 60:02d}"

    async with db.transaction():
        updated = await db.fetch(
            """
            UPDATE broadcast_schedules
               SET fire_at = fire_at + ($4 || ' minutes')::interval
             WHERE event_id = $1
               AND session_id = ANY($2::int[])
               AND type = ANY($3::text[])
               AND status IN ('draft', 'pending')
               AND fire_at IS NOT NULL
            RETURNING id
            """,
            event_id, target_session_ids, list(SHIFTABLE_TYPES), str(data.minutes),
        )

        # Двигаем саму программу — иначе рассылки уедут, а расписание останется.
        for pr in program_rows:
            await db.execute(
                "UPDATE conf_sessions SET start_time = $1, end_time = $2 WHERE id = $3",
                _shift_hhmm(pr["start_time"], data.minutes),
                _shift_hhmm(pr["end_time"], data.minutes),
                pr["id"],
            )

    if program_rows:
        from app.api.modules.conference import regenerate_landing_data
        await regenerate_landing_data(event_id, db)

    return {
        "ok": True,
        "shifted": len(updated),
        "speakers_affected": len(target_session_ids),
        "sessions_shifted": len(program_rows),
        "minutes": data.minutes,
    }


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
    # Пометка «галочки чатов переопределены вручную» (миграция 235): при TRUE
    # движок берёт send_to_* строго из рассылки, не подмешивая шаблон.
    chats_overridden: Optional[bool] = None


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

    # ⚠️ Навигация по чату (chat_nav) — настраивается ТОЛЬКО время (правило
    # владельца 22.09.2026). Эта рассылка по смыслу уходит ровно в чаты события
    # (TG/VK/MAX берутся из самого события), в личку — никому. Аудиторию, каналы,
    # email и «общие чаты / личные каналы» ей задавать нечего, поэтому на фронте
    # их не показываем, а здесь глушим принудительно: эндпоинт публичный, а
    # молча записанный мусор сломал бы отправку без единого следа в логах.
    # Особенно важен `chats_overridden`: TRUE отключает наследование
    # send_to_event_chats/pin_in_chat от шаблона (tasks/broadcast.py), и после
    # обычного «Задать время» навигация перестала бы уходить в чат и
    # закрепляться. Такая же фиксация уже стоит в update_template.
    sch_type = await db.fetchval(
        "SELECT type FROM broadcast_schedules WHERE id=$1 AND event_id=$2",
        schedule_id, event_id,
    )
    # ⚠️⚠️ РАССЫЛКИ В ЧАТ СПИКЕРОВ — то же правило (24.09.2026). Они уходят
    # РОВНО в чат спикеров события: доставка идёт по `send_to_speakers_chat`,
    # который для этих типов проставляется принудительно (см. update_template),
    # а `target_channel_ids` в этой ветке движка не читается вовсе. Выбор
    # площадки здесь ничего не менял, зато `chats_overridden = TRUE` отключал
    # наследование от шаблона — и после обычного «Задать время» рассылка
    # перестала бы уходить в чат и закрепляться.
    if sch_type in ("chat_nav", "speakers_call", "speakers_day", "speakers_howto"):
        data.is_test = False
        data.audience_include = None
        data.audience_exclude = None
        data.target_channel_ids = None
        data.send_to_event_chats = None
        data.send_to_client_chats = None
        data.send_to_private_chats = None
        data.chats_overridden = None

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
    if data.chats_overridden is not None:
        _add("chats_overridden", data.chats_overridden)

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
        "SELECT id, type, audience_include, audience_exclude, text, photo_url, button_text, button_url, "
        "send_to_event_chats, send_to_speakers_chat, pin_in_chat, nav_items "
        "FROM broadcast_templates WHERE id=$1 AND event_id=$2",
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
    # День программы (для дневных типов) — клиент выбирает в селекторе «День».
    # Пишем как есть; message_builder возьмёт его в приоритете над датой fire_at.
    row = await db.fetchrow(
        """
        INSERT INTO broadcast_schedules
          (event_id, template_id, type, session_id, day, fire_at, status, is_test, audience_include, audience_exclude,
           snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id,
           send_to_event_chats, send_to_speakers_chat, pin_in_chat, nav_items)
        VALUES ($1, $2, $3, $4, $15, $5, $13, $6, $7, $8, $9, $10, $11, $12, $14,
                $16, $17, $18, $19)
        RETURNING id, type, fire_at, status, is_test, audience_include, audience_exclude, day
        """,
        event_id, tpl["id"], tpl["type"], data.session_id, dt_utc, data.is_test, aud_include, aud_exclude,
        tpl["text"], tpl["photo_url"], tpl["button_text"], tpl["button_url"], new_status, client_id,
        data.day,
        # ⚠️ Доставку в чат, закреп и пункты навигации копируем В ЗАПИСЬ:
        # снимок текста здесь уже делается, и пункты — часть того же снимка.
        # Иначе правка шаблона после постановки в очередь меняла бы то, что
        # человек уже утвердил.
        bool(tpl["send_to_event_chats"]), bool(tpl["send_to_speakers_chat"]),
        bool(tpl["pin_in_chat"]), _nav_items_param(tpl["nav_items"]),
    )
    return dict(row)


# ─── Произвольная рассылка (без шаблона) ─────────────────────────────────

class ButtonItem(BaseModel):
    text: str
    url: str


class AddCustomRequest(BaseModel):
    fire_at: str
    text: str
    subject: Optional[str] = None               # тема (email Subject + жирная первая строка TG/VK/MAX)
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
    # Выбранный спикер/организатор/жюри (event_collaborators.id) — тогда работают
    # спикерские плейсхолдеры и подставляется его фото. None = обычное сообщение.
    speaker_ec_id: Optional[int] = None
    # Привязка ко ДНЮ программы — тогда работают дневные плейсхолдеры
    # ({day_program}, {day_date}, {stream_url} комнаты дня и т.д.). None = без дня.
    day: Optional[int] = None
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
           send_to_private_chats, client_id, target_channel_ids, day, snapshot_subject)
        VALUES ($1, NULL, 'custom', $15, $2, $16, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $17, $18, $19)
        RETURNING id, type, fire_at, status, is_test
        """,
        event_id, dt_utc, data.is_test, data.audience_include, data.audience_exclude,
        data.text, snap_photo, _json.dumps(buttons_json), snap_video, snap_mtype,
        data.send_to_event_chats, data.send_to_client_chats, data.send_to_private_chats, client_id,
        speaker_ec_id, status_val, data.target_channel_ids, data.day, (data.subject or None)
    )
    return dict(row)


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
            session_id = $15, target_channel_ids = $16, day = $17
        WHERE id = $10 AND event_id = $11 AND type = 'custom'
        RETURNING id, type, fire_at, status, is_test
        """,
        dt_utc, data.is_test, data.audience_include, data.audience_exclude,
        data.text, snap_photo, _json.dumps(buttons_json), snap_video, snap_mtype,
        schedule_id, event_id, data.send_to_event_chats, data.send_to_client_chats,
        data.send_to_private_chats, speaker_ec_id, data.target_channel_ids, data.day,
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
                p["photo_url"] = await import_remote_image_to_r2(client_id, p["photo_url"], db=db)
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
    return {"ok": True, "errors": [], "created": len(created_ids), "ids": created_ids,
            "warnings": warnings}


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

    # «Косячные» черновики НЕ блокируют запуск всей очереди — просто пропускаем их
    # (без времени / с прошедшим временем). Запускаем ВСЕ годные.
    null_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='draft' AND fire_at IS NULL",
        event_id
    ) or 0
    past_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='draft' "
        "AND fire_at IS NOT NULL AND fire_at < (NOW() - INTERVAL '5 minutes')",
        event_id
    ) or 0

    # Переводим в pending только годные draft (есть время И оно не в прошлом).
    await db.execute(
        "UPDATE broadcast_schedules SET status='pending' "
        "WHERE event_id=$1 AND status='draft' "
        "  AND fire_at IS NOT NULL AND fire_at >= (NOW() - INTERVAL '5 minutes')",
        event_id
    )

    count = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE event_id=$1 AND status='pending'", event_id
    )
    skipped = null_fire + past_fire
    msg = f"Очередь активирована. {count} рассылок уйдут по расписанию."
    if skipped:
        parts = []
        if null_fire: parts.append(f"{null_fire} без времени")
        if past_fire: parts.append(f"{past_fire} с прошедшим временем")
        msg += f" Пропущено: {', '.join(parts)} — задайте им время отдельно."
    # Celery Beat сам подхватит по расписанию — нам не нужно ничего дополнительно делать.
    return {"ok": True, "queued": count,
            "skipped_no_time": null_fire, "skipped_past": past_fire, "message": msg}


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

    # «Косячные» черновики НЕ блокируют весь запуск — просто пропускаем их:
    #  - без времени (fire_at IS NULL) — нужно задать время отдельно;
    #  - с прошедшим временем (ушли бы мгновенно / не подхватятся планировщиком).
    # Запускаем ТОЛЬКО годные (draft + fire_at в будущем с люфтом 5 мин).
    null_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE id = ANY($1::int[]) AND event_id=$2 AND status='draft' AND fire_at IS NULL",
        ids, event_id
    ) or 0
    past_fire = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE id = ANY($1::int[]) AND event_id=$2 "
        "AND status='draft' AND fire_at IS NOT NULL AND fire_at < (NOW() - INTERVAL '5 minutes')",
        ids, event_id
    ) or 0

    await db.execute(
        "UPDATE broadcast_schedules SET status='pending' "
        "WHERE id = ANY($1::int[]) AND event_id=$2 AND status='draft' "
        "  AND fire_at IS NOT NULL AND fire_at >= (NOW() - INTERVAL '5 minutes')",
        ids, event_id
    )
    # queued — сколько реально ушло в pending этим вызовом (только годные из выбранных).
    queued = await db.fetchval(
        "SELECT COUNT(*) FROM broadcast_schedules WHERE id = ANY($1::int[]) AND event_id=$2 AND status='pending'",
        ids, event_id
    )
    return {"ok": True, "queued": queued, "skipped_no_time": null_fire, "skipped_past": past_fire}


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


@router.post("/schedules/{schedule_id}/recall", summary="Отозвать (удалить у получателей) отправленную рассылку")
async def recall_schedule(
    event_id: int,
    schedule_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """Удаляет уже отправленные сообщения рассылки у получателей в Telegram
    (личные + групповые чаты). Работает только для сообщений, у которых при
    отправке был сохранён message_id (личные/чат-TG с 2026-07-16), и только в
    пределах 48 часов после отправки (ограничение Telegram)."""
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    row = await db.fetchrow(
        "SELECT id FROM broadcast_schedules WHERE id=$1 AND event_id=$2",
        schedule_id, event_id
    )
    if not row:
        raise HTTPException(status_code=404, detail="Рассылка не найдена")
    from app.services.broadcast_recall import recall_broadcast
    result = await recall_broadcast(db, schedule_id)
    return result


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

    # ⚠️ Мёртвую ссылку на фото НЕ копируем. Фото рассылок уборщик удаляет
    # через сутки после отправки: копируя старую рассылку, легко утащить ссылку
    # на уже удалённый файл — человек получил бы рассылку без картинки и не
    # понял почему. Проверяем и честно предупреждаем.
    from app.services import r2_storage as _r2
    snap_photo = row["snapshot_photo"]
    photo_warning = None
    if snap_photo and not await _r2.object_exists(snap_photo):
        snap_photo = None
        photo_warning = ("Картинка исходной рассылки уже удалена — она стирается "
                         "через сутки после отправки. Добавьте изображение заново.")

    # ⚠️ Копия создаётся БЕЗ даты (fire_at=NULL), чтобы старая дата не утащила
    # рассылку в мгновенную отправку. Клиент указывает новую дату при запуске.
    # client_id копии = client_id оригинала: у коллаб-события очередь у каждого
    # организатора своя, и копия должна остаться в базе того же владельца —
    # иначе она пропала бы из его очереди (список фильтрует по client_id).
    new_id = await db.fetchval(
        """INSERT INTO broadcast_schedules
           (event_id, template_id, session_id, type, audience_include, audience_exclude,
            audience_type, fire_at, status, is_test,
            snapshot_text, snapshot_photo, snapshot_btn_text, snapshot_btn_url, client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'draft',$8,$9,$10,$11,$12,$13)
           RETURNING id""",
        row["event_id"], row["template_id"], row["session_id"], row["type"],
        row["audience_include"], row["audience_exclude"], row["audience_type"],
        row["is_test"],
        row["snapshot_text"], snap_photo, row["snapshot_btn_text"], row["snapshot_btn_url"],
        row["client_id"]
    )
    return {"ok": True, "id": new_id, "warning": photo_warning}


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
        WHERE bl.schedule_id = $1 AND bl.platform_user_id IS NOT NULL
        ORDER BY bl.sent_at
        """,
        schedule_id
    )
    # Отправки В ЧАТЫ (миграция 220): platform_user_id NULL, инфа в chat_* полях.
    chat_rows = await db.fetch(
        """SELECT status, error, sent_at, chat_kind, chat_platform, chat_ref, chat_title
             FROM broadcast_log
            WHERE schedule_id = $1 AND chat_kind IS NOT NULL
            ORDER BY sent_at""",
        schedule_id,
    )
    from app.services.email_funnel_stats import email_funnel_stats
    return {
        "log": [dict(r) for r in rows],
        "chats": [dict(r) for r in chat_rows],
        "email_stats": await email_funnel_stats(db, schedule_id),
    }


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

    # Уже отправленная рассылка → показываем РЕАЛЬНО отправленный текст (snapshot,
    # зафиксированный движком в момент отправки), а не пересобираем из текущего
    # шаблона. Иначе после правки шаблона превью отправленной рассылки показывало бы
    # новый текст и сырые плейсхолдеры темы ({speaker_topic}) — не то, что ушло людям.
    if schedule["status"] in ("done", "cancelled") and (schedule.get("snapshot_text") not in (None, "")):
        snap_buttons = schedule.get("snapshot_buttons")
        if isinstance(snap_buttons, str):
            try:
                import json as _json
                snap_buttons = _json.loads(snap_buttons)
            except Exception:
                snap_buttons = []
        snap_text = schedule.get("snapshot_text") or ""
        snap_btn = schedule.get("snapshot_btn_url") or ""
        # Подарки-лид-магниты в снимке помечены токенами ⟦GF:kind:slug⟧ — раскрываем
        # ссылкой на воронку по каждой площадке (как в обычном превью).
        from app.services.share_links import resolve_gift_funnel_tokens
        # ⚠️ Email — такая же вкладка превью: текст письма отличается
        # ({signup_link} разворачивается во все площадки), и кнопок там три.
        _plats_sent = ["telegram", "vk", "max", "email"]
        text_by_platform = {}
        btn_by_platform = {}
        # Навигация по чату: резолвим пункты ОДИН раз, подставляем под каждую
        # площадку — так превью показывает ровно те ссылки, что уйдут в чат.
        _nav_resolved = await _preview_nav_resolved(db, schedule, event_id)
        for _p in _plats_sent:
            _sg = await _signup_link_preview(db, client_id, event_id, _p) if event_id else ""
            text_by_platform[_p] = _apply_nav_preview((await resolve_gift_funnel_tokens(
                db, client_id=client_id, text=snap_text, platform=_p)
            ).replace("⟦SIGNUP⟧", _sg).replace("{signup_link}", _sg), _nav_resolved, _p)
            btn_by_platform[_p] = (await resolve_gift_funnel_tokens(
                db, client_id=client_id, text=snap_btn, platform=_p)
            ).replace("⟦SIGNUP⟧", _sg).replace("{signup_link}", _sg)
        return {
            "text": text_by_platform.get("telegram") or snap_text,
            "text_by_platform": text_by_platform,
            "button_url_by_platform": btn_by_platform,
            "buttons_by_platform": (await _buttons_by_platform(
                db, client_id, event_id, snap_buttons or [], _plats_sent)
            ) if event_id else {},
            "subject": schedule.get("snapshot_subject"),
            "photo": schedule.get("snapshot_photo"),
            "video": schedule.get("snapshot_video"),
            "media_type": schedule.get("snapshot_media_type"),
            "button_text": schedule.get("snapshot_btn_text"),
            "button_url": schedule.get("snapshot_btn_url"),
            "buttons": snap_buttons or [],
            "template_type": tpl_type,
            "is_sent_snapshot": True,
        }

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
        explicit_day=schedule.get("day"),
        # В превью платформа неизвестна (одно сообщение на все) — показываем все
        # каналы поддержки блоком. При отправке Celery подставит контакт СВОЕЙ площадки.
        support_link=await _support_link_preview(db, client_id),
        # ⚠️ Ссылку регистрации НЕ подставляем здесь: она разная на каждой
        # площадке. Оставляем метку и раскрываем ниже — по вкладкам, как подарки.
        signup_link="\u27e6SIGNUP\u27e7",
    )

    # Подарки-лид-магниты помечены токенами ⟦GF:kind:slug⟧ — раскрываем ссылкой
    # на воронку по каждой площадке.
    # ⚠️ Вкладки строим ТОЛЬКО по площадкам, где у клиента подключён свой канал
    # (get_active_platforms). Иначе клиент видел вкладки VK/MAX, которых у него нет,
    # с пустой ссылкой на воронку — и думал, что рассылка сломана.
    from app.services.share_links import resolve_gift_funnel_tokens
    # В превью ссылка эфира несёт хвост ?c=__CT__ (сквозной contact_id получателя) —
    # показываем читаемой меткой, при реальной отправке Celery подставит id.
    if content.get("text"):
        content["text"] = content["text"].replace("?c=__CT__", "?c=ВАШ_ID")
    if content.get("button_url"):
        content["button_url"] = content["button_url"].replace("?c=__CT__", "?c=ВАШ_ID")
    base_text = content["text"] or ""
    base_btn = content.get("button_url") or ""
    # Подключённая площадка = у клиента есть ЛЮБОЙ свой канал на ней (то, что он
    # видит в разделе «Каналы»). Флаг cc.is_active тут НЕ смотрим — это «главный
    # канал площадки», а не факт подключения: у клиента может быть доп. канал без
    # галочки, площадка всё равно подключена. Системные каналы не считаем.
    _rows = await db.fetch(
        """SELECT DISTINCT ch.platform_slug
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND ch.is_system = FALSE""",
        client_id)
    _active = {r["platform_slug"] for r in _rows}
    # \u26a0\ufe0f EMAIL \u2014 \u0442\u0430\u043a\u0430\u044f \u0436\u0435 \u043f\u043b\u043e\u0449\u0430\u0434\u043a\u0430 \u043f\u0440\u0435\u0432\u044c\u044e, \u043a\u0430\u043a \u043c\u0435\u0441\u0441\u0435\u043d\u0434\u0436\u0435\u0440\u044b, \u0438 \u0442\u0435\u043a\u0441\u0442 \u0442\u0430\u043c \u0414\u0420\u0423\u0413\u041e\u0419:
    # {signup_link} \u0440\u0430\u0437\u0432\u043e\u0440\u0430\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044f \u0432\u043e \u0412\u0421\u0415 \u0441\u0441\u044b\u043b\u043a\u0438 \u0441 \u043f\u043e\u0434\u043f\u0438\u0441\u044f\u043c\u0438 (\u0432 \u043c\u0435\u0441\u0441\u0435\u043d\u0434\u0436\u0435\u0440
    # \u0443\u0445\u043e\u0434\u0438\u0442 \u0442\u043e\u043b\u044c\u043a\u043e \u0441\u0432\u043e\u044f). \u0411\u0435\u0437 \u0432\u043a\u043b\u0430\u0434\u043a\u0438 \u043a\u043b\u0438\u0435\u043d\u0442 \u043f\u0440\u043e\u0432\u0435\u0440\u044f\u043b \u043f\u0438\u0441\u044c\u043c\u043e \u0432\u0441\u043b\u0435\u043f\u0443\u044e.
    # \u26a0\ufe0f Email-\u043a\u0430\u043d\u0430\u043b \u0443 \u0431\u043e\u043b\u044c\u0448\u0438\u043d\u0441\u0442\u0432\u0430 \u043a\u043b\u0438\u0435\u043d\u0442\u043e\u0432 \u0421\u0418\u0421\u0422\u0415\u041c\u041d\u042b\u0419 (is_system=TRUE) \u0438 \u0432
    # \u0432\u044b\u0431\u043e\u0440\u043a\u0443 \u0432\u044b\u0448\u0435 \u043d\u0435 \u043f\u043e\u043f\u0430\u0434\u0430\u0435\u0442 \u2014 \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u0434\u043e\u0431\u0430\u0432\u043b\u044f\u0435\u043c \u0435\u0433\u043e \u043e\u0442\u0434\u0435\u043b\u044c\u043d\u043e\u0439 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u043e\u0439.
    _plats = [p for p in ("telegram", "vk", "max") if p in _active]
    if await db.fetchval(
        """SELECT 1 FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND ch.platform_slug = 'email'
              AND cc.is_active = TRUE LIMIT 1""", client_id):
        _plats.append("email")
    text_by_platform = {}
    btn_by_platform = {}
    # \u041d\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u044f \u043f\u043e \u0447\u0430\u0442\u0443 \u2014 \u0442\u0435 \u0436\u0435 \u0441\u0441\u044b\u043b\u043a\u0438, \u0447\u0442\u043e \u0443\u0439\u0434\u0443\u0442 \u0432 \u0447\u0430\u0442 (\u0440\u0435\u0437\u043e\u043b\u0432 \u043e\u0434\u0438\u043d \u043d\u0430 \u0432\u0441\u0435
    # \u043f\u043b\u043e\u0449\u0430\u0434\u043a\u0438, \u043f\u043e\u0434\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430 \u2014 \u043f\u043e\u0434 \u043a\u0430\u0436\u0434\u0443\u044e).
    _nav_resolved = await _preview_nav_resolved(db, schedule, event_id)
    for _p in _plats:
        _signup = await _signup_link_preview(db, client_id, event_id, _p)
        text_by_platform[_p] = _apply_nav_preview((await resolve_gift_funnel_tokens(
            db, client_id=client_id, text=base_text, platform=_p)
        ).replace("\u27e6SIGNUP\u27e7", _signup), _nav_resolved, _p)
        btn_by_platform[_p] = (await resolve_gift_funnel_tokens(
            db, client_id=client_id, text=base_btn, platform=_p)
        ).replace("\u27e6SIGNUP\u27e7", _signup)

    return {
        # base text/button — раскрыты по TG-приоритету (чтобы сырой ⟦GF⟧ не светился
        # у старого фронта); новый фронт берёт text_by_platform для вкладок.
        # Нет подключённых площадок (или нет TG) — фолбэк на первую доступную,
        # иначе на сырой текст: KeyError тут уронил бы всё превью.
        "text": (text_by_platform.get("telegram")
                 or next(iter(text_by_platform.values()), base_text)),
        "text_by_platform": text_by_platform,
        "button_url_by_platform": btn_by_platform,
        # ⚠️ Кнопки ПО ПЛОЩАДКАМ: в письме кнопка {signup_link} разворачивается
        # в три (см. tasks/broadcast.py), в мессенджере остаётся одна. Без
        # этого превью показывало одну кнопку на всех вкладках.
        "buttons_by_platform": await _buttons_by_platform(
            db, client_id, event_id, content.get("buttons") or [], _plats),
        "subject": content.get("subject"),
        "photo": content["photo"],
        "video": content.get("video"),
        "media_type": content.get("media_type"),
        "button_text": content.get("button_text"),
        "button_url": btn_by_platform["telegram"],
        "buttons": content.get("buttons") or [],
        "template_type": tpl_type,
    }




# ─────────────────────────────────────────
# ТЕСТОВАЯ РАССЫЛКА
# ─────────────────────────────────────────

async def _load_test_targets(db, client_id: int):
    """Тестовые ID клиента + токены платформ. Кидает 400, если тестовых нет."""
    client_row = await db.fetchrow(
        "SELECT test_telegram_ids, test_vk_ids, test_max_ids, test_email_ids, timezone "
        "FROM clients WHERE id=$1",
        client_id
    )
    from app.services.channels import get_client_telegram_token
    from app.config import settings as _settings
    bot_token = await get_client_telegram_token(client_id, db)
    test_tg_ids = client_row["test_telegram_ids"] or []
    test_vk_ids = client_row["test_vk_ids"] or []
    test_max_ids = client_row["test_max_ids"] or []
    test_email_ids = client_row["test_email_ids"] or []
    if not (test_tg_ids or test_vk_ids or test_max_ids or test_email_ids):
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
    # test_email_ids отдаём последним — вызывающие, которым email не нужен,
    # распаковывают первые 6 значений как раньше.
    return bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token, tz, test_email_ids


async def _test_unsubscribe_token(db, client_id: int, addr: str, ch_dict: dict):
    """Рабочий токен отписки для ТЕСТОВОГО письма.

    ⚠️ Тестовое письмо клиент шлёт себе, чтобы проверить, как оно выглядит, —
    и жмёт в нём «Отписаться». Раньше туда писали строку "test", и человек
    упирался в «Ссылка недействительна» (жалоба 2026-08-12). Собираем
    настоящий токен по контакту с этим адресом.

    Не нашли контакт (адрес не из базы) → возвращаем None: подвал с отпиской
    в письмо не попадёт вовсе. Это честнее заведомо битой ссылки, а для
    проверки вёрстки подвал не обязателен.
    """
    try:
        from app.services.contact_merge import normalize_email
        from app.services.unsubscribe_token import make_email_unsubscribe_token

        email_norm = normalize_email(addr)
        if not email_norm:
            return None
        row = await db.fetchrow(
            """SELECT pu.contact_id, cc.id AS client_channel_id
                 FROM platform_users pu
                 JOIN contacts c ON c.id = pu.contact_id AND c.is_active = TRUE
                 JOIN client_channels cc ON cc.client_id = c.client_id
                 JOIN channels ch ON ch.id = cc.channel_id AND ch.platform_slug = 'email'
                WHERE c.client_id = $1 AND pu.platform_slug = 'email'
                  AND pu.platform_user_id = $2
                LIMIT 1""",
            client_id, email_norm)
        if not row:
            return None
        return make_email_unsubscribe_token(
            client_id=client_id,
            contact_id=row["contact_id"],
            client_channel_id=row["client_channel_id"],
        )
    except Exception:
        logger.warning("Не удалось собрать токен отписки для тестового письма %s", addr)
        return None


async def _send_content_to_tests(content: dict, bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token,
                                 db=None, client_id: int | None = None,
                                 event_id: int | None = None,
                                 test_email_ids=None, nav_resolved=None):
    """Шлёт готовый content (text/photo/video/buttons) во все тестовые ID всех платформ.

    db/client_id — чтобы раскрыть токены воронки подарков ⟦GF⟧ ссылкой СВОЕЙ
    площадки (как в боевой рассылке). Без них токены остаются как есть.

    nav_resolved — пункты навигации по чату, уже с резолвленными ссылками.
    ⚠️ Тест обязан показывать ТО ЖЕ, что уйдёт: без этого в тестовом сообщении
    остался бы сырой {chat_nav_items}, и проверить пост было бы нечем."""
    from app.services.share_links import resolve_gift_funnel_tokens
    text = content.get("text") or ""
    photo = content.get("photo")
    video = content.get("video")
    m_type = content.get("media_type")
    buttons = content.get("buttons") or []
    btn_text = content.get("button_text") or (buttons[0]["text"] if buttons else None)
    btn_url = content.get("button_url") or (buttons[0]["url"] if buttons else None)

    # {signup_link} тоже раскрывается ПО ПЛОЩАДКЕ (метка ⟦SIGNUP⟧ пришла из
    # build_message_content): в тест на VK должна уйти вк-ссылка, а не телеграмная.
    async def _signup(platform: str) -> str:
        if not (db and client_id and event_id):
            return ""
        return await _signup_link_preview(db, client_id, event_id, platform)

    async def _txt(platform: str) -> str:
        t = await resolve_gift_funnel_tokens(db, client_id=client_id, text=text, platform=platform) if db else text
        t = (t or "").replace("\u27e6SIGNUP\u27e7", await _signup(platform))
        # \u26a0\ufe0f {first_name} \u0432 \u0431\u043e\u0435\u0432\u043e\u0439 \u0440\u0430\u0441\u0441\u044b\u043b\u043a\u0435 \u043f\u043e\u0434\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442 Celery \u043f\u043e \u043a\u0430\u0436\u0434\u043e\u043c\u0443
        # \u043f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u044e. \u0412 \u0422\u0415\u0421\u0422\u0415 \u043f\u043e\u0434\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438 \u043d\u0435 \u0431\u044b\u043b\u043e \u043d\u0438 \u043d\u0430 \u043e\u0434\u043d\u043e\u0439 \u043f\u043b\u043e\u0449\u0430\u0434\u043a\u0435 \u2014
        # \u043a\u043b\u0438\u0435\u043d\u0442 \u0432\u0438\u0434\u0435\u043b \u0441\u044b\u0440\u043e\u0439 \u00ab{first_name}\u00bb \u0438 \u0441\u0447\u0438\u0442\u0430\u043b \u043f\u043b\u0435\u0439\u0441\u0445\u043e\u043b\u0434\u0435\u0440 \u0441\u043b\u043e\u043c\u0430\u043d\u043d\u044b\u043c.
        # \u0418\u043c\u044f \u0431\u0435\u0440\u0451\u043c \u041d\u0410\u0421\u0422\u041e\u042f\u0429\u0415\u0415 \u2014 \u0442\u0435\u0441\u0442\u043e\u0432\u043e\u0433\u043e \u043f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u044f (\u0441\u043c. _first_name_for_test);
        # \u0437\u0430\u0433\u043b\u0443\u0448\u0435\u043a \u0432\u0440\u043e\u0434\u0435 \u00ab\u0434\u0440\u0443\u0433\u00bb \u043d\u0435 \u043f\u043e\u0434\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u043c \u043d\u0438\u0433\u0434\u0435.
        if "{first_name}" in t:
            t = _strip_first_name(t)
        # Навигация по чату — ссылками этой же площадки.
        t = _apply_nav_preview(t, nav_resolved or [], platform)
        return t

    async def _burl(platform: str):
        u = await resolve_gift_funnel_tokens(db, client_id=client_id, text=btn_url, platform=platform) if (db and btn_url) else btn_url
        return (u or "").replace("\u27e6SIGNUP\u27e7", await _signup(platform)) if u else u

    async def _burl_raw(raw_url: str, platform: str) -> str:
        """\u0422\u043e \u0436\u0435, \u0447\u0442\u043e _burl, \u043d\u043e \u0434\u043b\u044f \u041f\u0420\u041e\u0418\u0417\u0412\u041e\u041b\u042c\u041d\u041e\u0419 \u0441\u0441\u044b\u043b\u043a\u0438 \u0438\u0437 \u0441\u043f\u0438\u0441\u043a\u0430 \u043a\u043d\u043e\u043f\u043e\u043a.

        \u041d\u0443\u0436\u0435\u043d, \u043a\u043e\u0433\u0434\u0430 \u043a\u043d\u043e\u043f\u043e\u043a \u043d\u0435\u0441\u043a\u043e\u043b\u044c\u043a\u043e: _burl \u0443\u043c\u0435\u0435\u0442 \u0442\u043e\u043b\u044c\u043a\u043e \u043e\u0434\u043d\u0443 (button_url), \u0438
        \u0443 \u043e\u0441\u0442\u0430\u043b\u044c\u043d\u044b\u0445 \u043a\u043d\u043e\u043f\u043e\u043a \u0442\u043e\u043a\u0435\u043d\u044b \u0432\u043e\u0440\u043e\u043d\u043a\u0438 \u0438 {signup_link} \u043e\u0441\u0442\u0430\u043b\u0438\u0441\u044c \u0431\u044b \u0441\u044b\u0440\u044b\u043c\u0438.
        """
        if not raw_url:
            return ""
        u = await resolve_gift_funnel_tokens(db, client_id=client_id, text=raw_url, platform=platform) if db else raw_url
        return (u or "").replace("\u27e6SIGNUP\u27e7", await _signup(platform))

    out: list[dict] = []
    async with httpx.AsyncClient(timeout=20) as http:
        if test_tg_ids and bot_token:
            tg_text = await _txt("telegram")
            tg_burl = await _burl("telegram")
            for chat_id in [str(t) for t in test_tg_ids]:
                # Тест-отправка = истинная ссылка: подставляем реальный contact_id
                # тестового получателя (по его tg_id), как в боевой рассылке.
                _tt, _tb = tg_text, tg_burl
                _rep = ""          # подстановка ?c={contact_id}; пусто — если контакт не найден
                if db and client_id and ("?c=__CT__" in (tg_text or "") or "?c=__CT__" in (tg_burl or "")):
                    _ct = await db.fetchval(
                        "SELECT pu.contact_id FROM platform_users pu "
                        "JOIN contacts c_own ON c_own.id = pu.contact_id "
                        "WHERE c_own.client_id=$1 "
                        "AND pu.platform_slug='telegram' AND pu.platform_user_id=$2 LIMIT 1",
                        client_id, chat_id)
                    _rep = f"?c={_ct}" if _ct else ""
                    _tt = (tg_text or "").replace("?c=__CT__", _rep)
                    _tb = (tg_burl or "").replace("?c=__CT__", _rep) if tg_burl else tg_burl
                # ⚠️⚠️ КНОПКИ РАСКРЫВАЕМ, как ВК и МАКС ниже (_burl_raw). Здесь
                # список уходил СЫРЫМ: в кнопке оставался маркер ⟦SIGNUP⟧, и
                # Telegram отклонял ВСЁ сообщение («inline keyboard button URL
                # is invalid»). До получателя доходила только картинка — текст
                # и кнопки пропадали молча.
                _tg_buttons = []
                for _b in (buttons or []):
                    _u = await _burl_raw(_b.get("url") or "", "telegram")
                    if _u:
                        _tg_buttons.append({
                            "text": _b.get("text") or "Открыть",
                            "url": _u.replace("?c=__CT__", _rep),
                        })
                ok, err = await send_telegram_message(
                    http, bot_token, chat_id, _tt, photo, btn_text, _tb,
                    buttons=_tg_buttons or None,
                    video_url=video if m_type == "video" else None)
                out.append({"platform": "telegram", "chat_id": chat_id, "ok": ok, "error": err})
    if test_vk_ids:
        from app.services.channels import get_client_vk_token
        from app.config import settings as _vk_settings
        # Сообщество КЛИЕНТА; системное — только если своего нет (как в боевой).
        vk_token = (await get_client_vk_token(client_id, db)) if (db and client_id) else None
        vk_token = vk_token or _vk_settings.vk_system_group_token
        vk_burl = await _burl("vk")
        _vt = await _txt("vk")
        vk_text = _vt or ""

        # Собираем ВСЕ кнопки шаблона, а не одну: раньше тест брал только
        # button_text/button_url и терял остальные.
        vk_btn_pairs: list[tuple[str, str]] = []
        if buttons:
            for b in buttons:
                lbl = b.get("text") or b.get("label") or "Открыть"
                url = await _burl_raw(b.get("url") or "", "vk")
                if url:
                    vk_btn_pairs.append((lbl, url))
        elif btn_text and vk_burl:
            vk_btn_pairs.append((btn_text, vk_burl))

        # ⚠️ Клавиатура, вложение и текст — ОБЩИЙ модуль platform_delivery,
        # тот же, что у боевой рассылки. Своей сборки тут быть не должно:
        # именно от неё тест и бой разъезжались (фото ссылкой, теги дословно,
        # одна кнопка вместо всех).
        vk_keyboard = delivery.vk_keyboard(vk_btn_pairs)
        vk_attachment = await delivery.prepare_vk_photo(photo, token=vk_token, media_type=m_type)
        vk_text = delivery.vk_text(vk_text, video_url=video, media_type=m_type,
                                   link_fallback=True)

        for vid in [str(t) for t in test_vk_ids]:
            try:
                # ⚠️ token обязателен: без него vk_call подставляет СИСТЕМНОЕ
                # сообщество ПЛЮСОНа, и тест приходил от чужого имени (а тем,
                # кто на него не подписан, — не приходил вовсе).
                res = await delivery.send_vk(int(vid), vk_text, token=vk_token,
                                             keyboard=vk_keyboard, attachment=vk_attachment)
                out.append({"platform": "vk", "chat_id": vid, "ok": bool(res), "error": None if res else "VK send returned None"})
            except Exception as e:
                out.append({"platform": "vk", "chat_id": vid, "ok": False, "error": str(e)})
    if test_max_ids and max_token:
        max_burl = await _burl("max")
        # ⚠️ ВСЕ кнопки, а не одна. Раньше тест брал только button_text/button_url
        # и молча терял остальные: в шаблоне их две («Через Телеграм», «Через
        # MAX»), а в MAX приходила одна.
        max_rows: list[list[dict]] = []
        if buttons:
            for b in buttons:
                lbl = b.get("text") or b.get("label") or "Открыть"
                url = await _burl_raw(b.get("url") or "", "max")
                if url:
                    max_rows.append([{"text": lbl, "url": url}])
        elif btn_text and max_burl:
            max_rows.append([{"text": btn_text, "url": max_burl}])
        # ⚠️ Клавиатура, текст и вложение — ОБЩИЙ модуль platform_delivery
        # (тот же у боевой рассылки): HTML снимается, фото уходит вложением,
        # а не голой ссылкой в тексте.
        max_buttons = delivery.max_keyboard([(r[0]["text"], r[0]["url"]) for r in max_rows])
        max_text = delivery.max_text(await _txt("max"), video_url=video, media_type=m_type)
        max_attachment = await delivery.prepare_max_photo(photo, token=max_token, media_type=m_type)
        for mid in [str(t) for t in test_max_ids]:
            try:
                # ⚠️ recipient_kind='user' ОБЯЗАТЕЛЕН: в настройках указан id
                # ПРОФИЛЯ, а не беседы. По умолчанию функция шлёт через chat_id,
                # и MAX на id профиля отвечает 200 + chat.not.found — сообщение
                # молча не доходит. Боевая рассылка это делает верно
                # (tasks/broadcast.py), а тест — нет, поэтому тест в MAX не
                # доходил никогда.
                res = await delivery.send_max(int(mid), max_text, token=max_token,
                                              buttons=max_buttons, attachment=max_attachment)
                out.append({"platform": "max", "chat_id": mid, "ok": bool(res), "error": None if res else "MAX send returned None"})
            except Exception as e:
                out.append({"platform": "max", "chat_id": mid, "ok": False, "error": str(e)})

    # ── Email ───────────────────────────────────────────────────────────────
    # ⚠️ Раньше тестовая отправка email не умела ВОВСЕ: поле «Email» в
    # настройках было, галочка обещала письма, а код слал только TG/VK/MAX —
    # клиент видел «в бот пришло, на почту нет» и не понимал, почему.
    # Шлём напрямую по адресам из настроек, не требуя контакта в базе:
    # это проверка вёрстки письма, а не боевая рассылка.
    if test_email_ids and db and client_id:
        try:
            from app.services.email_sender import EmailSender, _build_from_header
            from app.services.client_domains import client_public_url
            ch_row = await db.fetchrow(
                """SELECT ch.email_from_local, ch.email_from_name, ch.email_subdomain
                     FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id=$1 AND ch.platform_slug='email' LIMIT 1""",
                client_id)
            cl_row = await db.fetchrow(
                "SELECT COALESCE(brand_name, name) AS brand FROM clients WHERE id=$1", client_id)
            # Свой почтовый домен клиента (если подключён) — письмо уйдёт от него.
            dom = await db.fetchrow(
                """SELECT domain, mail_from_local, mail_from_name FROM client_domains
                    WHERE client_id=$1 AND kind='mail' AND status='active' LIMIT 1""",
                client_id)
            ch_dict = dict(ch_row) if ch_row else {}
            if dom:
                ch_dict["email_domain"] = dom["domain"]
                ch_dict["email_from_local"] = dom["mail_from_local"] or "noreply"
                if dom["mail_from_name"]:
                    ch_dict["email_from_name"] = dom["mail_from_name"]
            # ⚠️ Берём text_email — тело БЕЗ приклеенного заголовка. В письме
            # тема идёт в Subject; если взять общий text, заголовок придёт
            # дважды: в теме и первой строкой письма.
            email_body = content.get("text_email")
            if email_body is None:
                email_body = await _txt("email")
            # ⚠️ Тело письма собираем ТЕМ ЖЕ кодом, что и боевая рассылка
            # (build_email_body), а не «текст с <br>». Раньше здесь была
            # ровно такая примитивная сборка — и в тестовое письмо не
            # попадали ни фото, ни обложка видео, ни кнопка: клиент видел
            # «в Telegram картинка пришла, а на почту нет» и не мог
            # проверить вёрстку до боевой отправки (жалоба 2026-08-14).
            # Фото уходит INLINE по Content-ID, поэтому inline_images
            # обязательно передать в sender.send — иначе <img src="cid:…">
            # останется битым.
            email_btn_url = await _burl("email")
            # ⚠️⚠️ КНОПКИ ПИСЬМА: маркер ⟦SIGNUP⟧ раскрываем (иначе в письмо
            # уходила кнопка с сырым маркером), а кнопку регистрации
            # РАЗВОРАЧИВАЕМ В ТРИ — по одной на площадку, ровно как боевая
            # рассылка (tasks/broadcast.py). Тест обязан показывать то же, что
            # получит человек, иначе проверять письмо бессмысленно.
            _email_buttons: list[dict] = []
            for _b in (buttons or []):
                _raw = (_b.get("url") or "").strip()
                if _raw == "⟦SIGNUP⟧" and db and client_id and event_id:
                    from app.services.share_links import (
                        get_client_bot_handles as _gh, get_client_vk_app_id as _gv,
                        build_event_signup_links as _bl,
                    )
                    _slug = await db.fetchval("SELECT slug FROM events WHERE id=$1", event_id)
                    _mm = await db.fetchrow(
                        "SELECT link_mode_telegram, link_mode_vk, link_mode_max "
                        "FROM clients WHERE id=$1", client_id)
                    _lnk = _bl(
                        await _gh(db, client_id), _slug or "",
                        modes={"telegram": _mm["link_mode_telegram"], "vk": _mm["link_mode_vk"],
                               "max": _mm["link_mode_max"]} if _mm else {},
                        vk_app_id=await _gv(db, client_id),
                    )
                    # Подписи кнопок — те же, что в боевой рассылке
                    # (tasks/broadcast.py): тест обязан совпадать с боем.
                    for _p, _lbl in (("telegram", "Зарегистрироваться через ТГ"),
                                     ("max", "Зарегистрироваться через МАХ"),
                                     ("vk", "Зарегистрироваться через ВК")):
                        if _lnk.get(_p):
                            _email_buttons.append({"text": _lbl, "url": _lnk[_p]})
                else:
                    _u = await _burl_raw(_raw, "email")
                    if _u:
                        _email_buttons.append({"text": _b.get("text") or "Открыть", "url": _u})
            built = await build_email_body(
                text=str(email_body),
                photo_url=photo,
                video_url=video,
                media_type=m_type,
                button_text=btn_text,
                button_url=email_btn_url,
                buttons=_email_buttons or None,
            )
            html = built.html
            email_body = built.text
            subj = content.get("subject") or "Тестовая рассылка"
            sender = EmailSender()
            pub_base = await client_public_url(db, client_id)
            for addr in test_email_ids:
                addr = str(addr).strip()
                if not addr:
                    continue
                try:
                    # ⚠️ Ссылка отписки в тестовом письме должна быть РАБОЧЕЙ.
                    # Раньше сюда жёстко писали `unsubscribe_token="test"` — и
                    # клиент, проверяя рассылку на себе, жал «Отписаться» и
                    # получал «Ссылка недействительна» (жалоба 2026-08-12).
                    # Токен собираем по реальному контакту с этим адресом;
                    # не нашли — пробуем контакт самого клиента, иначе шлём
                    # письмо вовсе без подвала отписки.
                    unsub = await _test_unsubscribe_token(db, client_id, addr, ch_dict)
                    sender.send(
                        channel=ch_dict,
                        client_brand_name=(cl_row["brand"] if cl_row else None),
                        to_email=addr,
                        subject=subj,
                        body_text=str(email_body),
                        body_html=html,
                        inline_images=(built.inline_images or None),
                        unsubscribe_token=unsub,
                        public_base_url=pub_base,
                    )
                    out.append({"platform": "email", "chat_id": addr,
                                "ok": True, "error": None})
                except Exception as e:
                    out.append({"platform": "email", "chat_id": addr,
                                "ok": False, "error": str(e)})
        except Exception as e:
            logger.warning("Тестовая email-отправка не удалась: %s", e)
            out.append({"platform": "email", "chat_id": "-", "ok": False, "error": str(e)})
    return out


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
    bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token, tz, test_email_ids = await _load_test_targets(db, client_id)

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
        explicit_day=schedule.get("day"),
        support_link=await _support_link_preview(db, client_id),
        # Метку раскроет _send_content_to_tests — ссылкой СВОЕЙ площадки.
        signup_link="\u27e6SIGNUP\u27e7",
    )
    # subject → жирной первой строкой (как в реальной отправке).
    # ⚠️ Только для TG/VK/MAX: у письма есть своё поле темы, и приклеенный
    # заголовок пришёл бы дважды — в теме и первой строкой тела. Поэтому
    # чистое тело кладём отдельно в text_email (его берёт email-ветка).
    subj = (content.get("subject") or "").strip()
    if subj:
        content = dict(content)
        content["text_email"] = content.get("text") or ""
        content["text"] = f"<b>{subj}</b>\n\n{content.get('text') or ''}"
    results = await _send_content_to_tests(content, bot_token, test_tg_ids, test_vk_ids, test_max_ids, max_token,
                                           db=db, client_id=client_id, event_id=event_id, test_email_ids=test_email_ids,
                                           nav_resolved=await _preview_nav_resolved(db, schedule, event_id))
    sent = sum(1 for r in results if r.get("ok"))
    return {"ok": True, "sent": sent, "total": len(results), "results": results}


@router.get("/templates/{template_id}/nav-preview", summary="Навигация по чату: ссылки по площадкам")
async def preview_chat_nav(
    event_id: int,
    template_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Готовые пункты навигации со ссылками — по каждой площадке.

    ⚠️ Зачем отдельный эндпоинт. Превью шаблона рисует ФРОНТ, а ссылки здесь
    строит только сервер: они зависят от ботов клиента, режима Mini App/веб и
    бота ВЛАДЕЛЬЦА лид-магнита. Фронт этого знать не может и раньше показывал
    вместо адреса подпись «ссылка на кабинет участника» — клиент не видел, что
    реально уйдёт в чат, и не мог проверить пост до отправки.

    Отдаём ровно то, что подставит отправка: тот же `resolve_nav_links`.
    """
    client_id = int(client["sub"])
    await _check_event(db, event_id, client_id)
    row = await db.fetchrow(
        "SELECT nav_items FROM broadcast_templates WHERE id=$1 AND event_id=$2",
        template_id, event_id)
    if not row:
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    from app.services.chat_nav import parse_items, render_nav_items, resolve_nav_links
    items = parse_items(row["nav_items"])
    if not items:
        return {"by_platform": {p: "" for p in ("telegram", "vk", "max")}}
    resolved = await resolve_nav_links(db, items=items, event_id=event_id, client_id=client_id)
    return {
        "by_platform": {
            p: render_nav_items(resolved, p) for p in ("telegram", "vk", "max")
        }
    }


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
    # {support_link} в тестовой отправке: текст один на все площадки, поэтому
    # показываем все каналы поддержки блоком (в реальной рассылке Celery подставит
    # контакт ТОЙ площадки, куда уходит сообщение).
    _sup_link = await _support_link_preview(db, client_id)
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
        from app.services.share_links import resolve_gift_funnel_tokens
        # {signup_link} → ссылка СВОЕЙ площадки (метка ⟦SIGNUP⟧ из build_message_content)
        _sg: dict[str, str] = {}
        for _p in ("telegram", "vk", "max"):
            _sg[_p] = await _signup_link_preview(db, client_id, event_id, _p)

        # \u041f\u0443\u043d\u043a\u0442\u044b \u043d\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u0438 \u043f\u043e \u0447\u0430\u0442\u0443 \u2014 \u0440\u0435\u0437\u043e\u043b\u0432\u0438\u043c \u043e\u0434\u0438\u043d \u0440\u0430\u0437 \u043d\u0430 \u0432\u0441\u0435 \u0442\u0435\u0441\u0442\u043e\u0432\u044b\u0435 \u043f\u043b\u043e\u0449\u0430\u0434\u043a\u0438.
        _nav_for_test = await _preview_nav_resolved(
            db, {"nav_items": tpl["nav_items"], "client_id": client_id, "template_id": template_id},
            event_id)

        def _sub(val, platform):
            if not val:
                return val
            v = (val or "").replace("\u27e6SIGNUP\u27e7", _sg.get(platform, ""))
            # {first_name} \u2014 \u0432 \u0431\u043e\u044e \u043f\u043e\u0434\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442 Celery per-\u043f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u044c; \u0432 \u0442\u0435\u0441\u0442\u0435
            # \u0443\u0431\u0438\u0440\u0430\u0435\u043c \u043f\u043b\u0435\u0439\u0441\u0445\u043e\u043b\u0434\u0435\u0440 (\u0437\u0430\u0433\u043b\u0443\u0448\u0435\u043a \u043d\u0435 \u043f\u043e\u0434\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u043c, \u0441\u043c. _strip_first_name).
            v = _strip_first_name(v) if "{first_name}" in v else v
            # \u041d\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u044f \u043f\u043e \u0447\u0430\u0442\u0443 \u2014 \u0441\u0441\u044b\u043b\u043a\u0430\u043c\u0438 \u044d\u0442\u043e\u0439 \u043f\u043b\u043e\u0449\u0430\u0434\u043a\u0438, \u043a\u0430\u043a \u0432 \u0431\u043e\u044e.
            return _apply_nav_preview(v, _nav_for_test, platform)

        out: list[dict] = []
        text = content.get("text") or ""
        photo = content.get("photo")
        video = content.get("video")
        m_type = content.get("media_type")
        btn_text = content.get("button_text")
        btn_url = content.get("button_url")
        raw_buttons = content.get("buttons") or None

        async def _btns(platform: str):
            """Кнопки под площадку — ТЕ ЖЕ, что в боевой отправке.

            ⚠️ Раньше тест брал только одиночную кнопку (`button_pairs(None, …)`)
            и МАССИВ `buttons` игнорировал: у рассылки с несколькими кнопками
            тест показывал не то, что уйдёт. Плюс адреса в массиве не проходили
            подстановку — именно так сырой «{signup_link}» доезжал до площадок
            и валил всю рассылку, а тест при этом выглядел нормальным.
            """
            if not raw_buttons:
                return None
            out = []
            for b in raw_buttons:
                if not isinstance(b, dict):
                    continue
                u = _sub(await resolve_gift_funnel_tokens(
                    db, client_id=client_id, text=b.get("url") or "", platform=platform), platform)
                if u:
                    out.append({**b, "url": u})
            return out or None

        # === Telegram ===
        if test_tg_ids and bot_token:
            tg_text = _sub(await resolve_gift_funnel_tokens(db, client_id=client_id, text=text, platform="telegram"), "telegram")
            tg_burl = _sub(await resolve_gift_funnel_tokens(db, client_id=client_id, text=btn_url, platform="telegram"), "telegram") if btn_url else btn_url
            tg_btns = await _btns("telegram")
            for chat_id in [str(t) for t in test_tg_ids]:
                ok, err = await send_telegram_message(
                    http, bot_token, chat_id, tg_text, photo, btn_text, tg_burl,
                    buttons=tg_btns,
                    video_url=video if m_type == "video" else None,
                )
                out.append({"platform": "telegram", "chat_id": chat_id, "ok": ok, "error": err})

        # === VK === (стрип HTML делает сам vk_api.send_message)
        if test_vk_ids:
            from app.services.channels import get_client_vk_token
            from app.config import settings as _vk_settings
            # Сообщество КЛИЕНТА; системное — только если своего нет.
            vk_token = (await get_client_vk_token(client_id, db)) if client_id else None
            vk_token = vk_token or _vk_settings.vk_system_group_token
            vk_btn_url = _sub(await resolve_gift_funnel_tokens(db, client_id=client_id, text=btn_url, platform="vk"), "vk") if btn_url else btn_url
            # ⚠️ Клавиатура, вложение и текст — ОБЩИЙ platform_delivery, тот же
            # у боевой рассылки. Своей сборки тут быть не должно.
            vk_pairs = delivery.button_pairs(await _btns("vk"), btn_text, vk_btn_url)
            vk_keyboard = delivery.vk_keyboard(vk_pairs)
            _vk_body = _sub(await resolve_gift_funnel_tokens(db, client_id=client_id, text=text, platform="vk"), "vk")
            vk_text = delivery.vk_text(_vk_body, video_url=video, media_type=m_type,
                                       link_fallback=True)
            vk_attachment = await delivery.prepare_vk_photo(photo, token=vk_token, media_type=m_type)
            for vid in [str(t) for t in test_vk_ids]:
                try:
                    res = await delivery.send_vk(int(vid), vk_text, token=vk_token,
                                                 keyboard=vk_keyboard, attachment=vk_attachment)
                    out.append({
                        "platform": "vk", "chat_id": vid,
                        "ok": bool(res), "error": None if res else "VK send returned None"
                    })
                except Exception as e:
                    out.append({"platform": "vk", "chat_id": vid, "ok": False, "error": str(e)})

        # === MAX === (стрип HTML — пока не делаем, MAX поддерживает HTML аналогично TG)
        if test_max_ids and max_token:
            max_btn_url = _sub(await resolve_gift_funnel_tokens(db, client_id=client_id, text=btn_url, platform="max"), "max") if btn_url else btn_url
            # ⚠️ ОБЩИЙ platform_delivery: HTML снимается, фото уходит вложением,
            # а не голой R2-ссылкой в начале текста (так было раньше).
            max_buttons = delivery.max_keyboard(
                delivery.button_pairs(await _btns("max"), btn_text, max_btn_url))
            _max_body = _sub(await resolve_gift_funnel_tokens(db, client_id=client_id, text=text, platform="max"), "max")
            max_text = delivery.max_text(_max_body, video_url=video, media_type=m_type)
            max_attachment = await delivery.prepare_max_photo(photo, token=max_token, media_type=m_type)
            for mid in [str(t) for t in test_max_ids]:
                try:
                    # ⚠️ recipient_kind='user' — см. пояснение в _send_content_to_tests:
                    # в настройках лежит id профиля, а не беседы; без этого MAX
                    # отвечает chat.not.found и сообщение не доходит.
                    res = await delivery.send_max(int(mid), max_text, token=max_token,
                                                  buttons=max_buttons, attachment=max_attachment)
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
                """SELECT cse.id AS session_id, """ + DISPLAY_NAME_SQL("c") + """ AS speaker_name
                   FROM event_collaborators cse
                   JOIN collaborators c ON c.id = cse.speaker_id
                   WHERE cse.event_id=$1 AND cse.is_visible=true AND cse.role = ANY($2::text[])
                   ORDER BY """ + collaborator_sort.order_by_sql("cse"),
                event_id, intro_roles
            )
        else:
            sessions = await db.fetch(
                """SELECT cse.id AS session_id, """ + DISPLAY_NAME_SQL("c") + """ AS speaker_name
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
                    support_link=_sup_link,
                    signup_link="\u27e6SIGNUP\u27e7",
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
                    support_link=_sup_link,
                    signup_link="\u27e6SIGNUP\u27e7",
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
            explicit_day=day,
            support_link=_sup_link,
            signup_link="\u27e6SIGNUP\u27e7",
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
