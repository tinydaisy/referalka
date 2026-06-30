"""
ЕДИНСТВЕННОЕ МЕСТО ДЛЯ ФОРМИРОВАНИЯ ТЕКСТА И ОТПРАВКИ СООБЩЕНИЙ РАССЫЛОК.

Все функции формирования текста шаблонов и отправки в Telegram живут ЗДЕСЬ.
Импортируются везде:
  - app/tasks/broadcast.py  (Celery)
  - app/api/modules/broadcasts.py  (FastAPI — превью и тест-отправка)

НИКОГДА не писать аналогичный код в другом месте.
"""
import re
import logging
import httpx
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from app.services import collaborator_sort


# Telegram parse_mode=HTML понимает только узкий набор тегов:
# <b>/<strong>, <i>/<em>, <u>/<ins>, <s>/<strike>/<del>, <a>, <code>,
# <pre>, <blockquote>, <span class="tg-spoiler">.
# Если в описании клиент написал <p>/<br>/<ul>/<li>/<h2>/<div> и т.п.,
# Telegram свалит запрос с "can't parse entities". Конвертируем такой
# HTML в Telegram-совместимый текст: блочные теги → переносы строк,
# списки → префикс «• ».
def html_to_telegram(s: str) -> str:
    if not s:
        return ""
    out = s
    out = re.sub(r"<br\s*/?>", "\n", out, flags=re.I)
    out = re.sub(r"</p\s*>", "\n\n", out, flags=re.I)
    out = re.sub(r"<p[^>]*>", "", out, flags=re.I)
    out = re.sub(r"<li[^>]*>", "• ", out, flags=re.I)
    out = re.sub(r"</li\s*>", "\n", out, flags=re.I)
    # Заголовки → отдельный абзац жирным
    out = re.sub(r"<h[1-6][^>]*>", "<b>", out, flags=re.I)
    out = re.sub(r"</h[1-6]\s*>", "</b>\n\n", out, flags=re.I)
    # Остальные неподдерживаемые блочные теги — просто удалить, оставив текст
    for tag in ("ul", "ol", "div", "section", "article", "span", "blockquote", "hr"):
        out = re.sub(rf"</?{tag}[^>]*>", "", out, flags=re.I)
    # Схлопываем тройные+ переносы строк
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


# VK messages.send не поддерживает форматирование вообще — теги уходят
# в чат как обычный текст («<b>привет</b>» отображается дословно).
# Эта функция превращает Telegram/HTML-разметку в чистый текст для VK.
# Правила:
#  - <br>, </p>, </div>, </h*> → переносы строк
#  - <li> → «• », </li> → \n
#  - <a href="URL">text</a> → URL (анкорный текст отбрасывается, VK сам
#    делает превью по ссылке)
#  - <b>/<i>/<u>/<s>/<em>/<strong>/<ins>/<del>/<strike>/<code>/<pre>/<span> и
#    прочее inline-форматирование — просто удаляются (содержимое остаётся)
#  - HTML-сущности &amp; &lt; &gt; &quot; &nbsp; → реальные символы
def html_to_vk_text(s: str) -> str:
    if not s:
        return ""
    out = s
    # Ссылки: <a href="URL">текст</a> → URL
    out = re.sub(r'<a\s+[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>.*?</a\s*>',
                 r'\1', out, flags=re.I | re.S)
    # Блочные → переносы строк
    out = re.sub(r"<br\s*/?>", "\n", out, flags=re.I)
    out = re.sub(r"</p\s*>", "\n\n", out, flags=re.I)
    out = re.sub(r"<p[^>]*>", "", out, flags=re.I)
    out = re.sub(r"<li[^>]*>", "• ", out, flags=re.I)
    out = re.sub(r"</li\s*>", "\n", out, flags=re.I)
    out = re.sub(r"<h[1-6][^>]*>", "", out, flags=re.I)
    out = re.sub(r"</h[1-6]\s*>", "\n\n", out, flags=re.I)
    out = re.sub(r"</div\s*>", "\n", out, flags=re.I)
    # Все оставшиеся теги (включая <b>/<i>/<u>/<s>/<em>/<strong>/<code>/...) — снести
    out = re.sub(r"</?[a-zA-Z][^>]*>", "", out)
    # HTML-сущности → символы
    out = (out
           .replace("&nbsp;", " ")
           .replace("&amp;", "&")
           .replace("&lt;", "<")
           .replace("&gt;", ">")
           .replace("&quot;", '"')
           .replace("&#39;", "'")
           .replace("&apos;", "'"))
    # Схлопываем тройные+ переносы строк
    out = re.sub(r"\n{3,}", "\n\n", out)
    # Пробелы перед/после переносов
    out = re.sub(r"[ \t]+\n", "\n", out)
    out = re.sub(r"\n[ \t]+", "\n", out)
    return out.strip()

logger = logging.getLogger(__name__)

RU_MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"]

ROLE_LABELS_INTRO = {
    "speaker": "Спикер",
    "headliner": "Хедлайнер",
    "partner": "Партнёр",
    "organizer": "Организатор",
    "jury": "Жюри",
}

ORDINALS = {1: "первом", 2: "втором", 3: "третьем", 4: "четвёртом", 5: "пятом"}
ROLE_LABELS_DAY = {"headliner": "Хедлайнер", "partner": "Партнёр", "organizer": "Организатор", "jury": "Жюри"}

DAY_TYPES = ("2h_before_unreg", "2h_before_reg", "30min_before", "day_live", "day_end",
             "day_before_09_12_unreg", "day_before_09_12_reg",
             "event_live")
SPEAKER_TYPES = ("gift", "speaker_intro", "5min_before")
CONF_TYPES = ("pre_conf",)


def _fmt_time(val) -> str:
    # Время теперь хранится строкой "HH:MM" — отдаём как есть, без TZ-математики.
    if not val:
        return ""
    return str(val)[:5]


def _fmt_time_msk(val) -> str:
    """Формат HH:MM МСК (для отображения в сообщениях/UI)."""
    s = _fmt_time(val)
    return f"{s} МСК" if s else ""


# ─── Формирование текста: speaker_intro ─────────────────────────────────────

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

    # Личный ник спикера (@username) — для упоминания/связи. Из platform_users.
    personal_raw = (personal_tg or "").strip().lstrip("@")
    personal_mention = f"@{personal_raw}" if personal_raw else ""

    if not topic:
        text = re.sub(r"^[^\n]*\{speaker_topic\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not ach_text:
        text = re.sub(r"^[^\n]*О спикере[^\n]*\n?", "", text, flags=re.MULTILINE)
        text = re.sub(r"^[^\n]*Регалии[^\n]*\n?", "", text, flags=re.MULTILINE)
        text = re.sub(r"^[^\n]*\{speaker_achievements\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not gift_title_v:
        text = re.sub(r"^[^\n]*\{gift_after_speech_title\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not gift_raffle_v:
        text = re.sub(r"^[^\n]*\{gift_raffle_title\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not tg_ch:
        text = re.sub(r"^[^\n]*\{speaker_tg\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not insta:
        text = re.sub(r"^[^\n]*\{speaker_instagram\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not personal_mention:
        text = re.sub(r"^[^\n]*\{speaker_personal_tg\}[^\n]*\n?", "", text, flags=re.MULTILINE)

    text = text.replace("{speaker_personal_tg}", personal_mention)
    text = text.replace("{speaker_name}", speaker_name or "")
    text = text.replace("{speaker_role}", role_label)
    text = text.replace("{speaker_topic}", topic)
    text = text.replace("{speaker_achievements}", ach_text)
    text = text.replace("{gift_after_speech_title}", gift_title_v)
    text = text.replace("{gift_raffle_title}", gift_raffle_v)
    # {landing_url} — новое имя плейсхолдера, {registration_url} оставляем для
    # совместимости со старыми шаблонами в БД клиентов (миграция 057).
    text = text.replace("{landing_url}", registration_url or "")
    text = text.replace("{registration_url}", registration_url or "")
    if tg_ch:
        text = text.replace("{speaker_tg}", f"<b>Тг канал:</b> {tg_ch}")
    if insta:
        text = text.replace("{speaker_instagram}", f"<b>Нельзяграм:</b> {insta}")

    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ─── Формирование текста: gift (подарок спикера) ────────────────────────────

def build_gift_message(speaker_name, personal_tg, gift_title, gift_url, tmpl_text=None):
    """Формирует сообщение-подарок.
    Если задан tmpl_text — используется он с подстановкой плейсхолдеров
    ({speaker_name}, {gift_title}, {gift_url}, {personal_tg}).
    Иначе — встроенный формат по умолчанию.
    """
    tg_raw = (personal_tg or "").strip()
    tg_mention = ("@" + tg_raw.lstrip("@")) if tg_raw else ""
    title = (gift_title or "").strip()
    url = (gift_url or "").strip()

    tmpl = (tmpl_text or "").strip()
    if tmpl and any(p in tmpl for p in ("{speaker_name}", "{gift_title}", "{gift_url}", "{personal_tg}")):
        text = tmpl
        # Построчно удаляем строки с пустыми плейсхолдерами
        if not title:
            text = re.sub(r"^[^\n]*\{gift_title\}[^\n]*\n?", "", text, flags=re.MULTILINE)
        if not url:
            text = re.sub(r"^[^\n]*\{gift_url\}[^\n]*\n?", "", text, flags=re.MULTILINE)
        if not tg_mention:
            text = re.sub(r"^[^\n]*\{personal_tg\}[^\n]*\n?", "", text, flags=re.MULTILINE)
        text = (text
                .replace("{speaker_name}", speaker_name or "")
                .replace("{gift_title}", title)
                .replace("{gift_url}", url)
                .replace("{personal_tg}", tg_mention))
        return text.strip()

    header = f"🎁 {speaker_name}: Подарки после эфира"
    if not title:
        body = f"🎁 Чтобы забрать материалы — пишите в личку {tg_mention}" if tg_mention else "🎁 Чтобы забрать материалы — напишите спикеру в личку"
    elif not url:
        body = f"{title}\nПишите в личку {tg_mention}" if tg_mention else title
    else:
        body = f"{title}\n{url}"
    return f"{header}\n\n{body}"


# ─── Формирование текста: pre_start (анонс спикера) ─────────────────────────

def build_pre_start_message(tmpl_text, speaker_name, speaker_topic, stream_url_val):
    text = tmpl_text or ""
    text = text.replace("{speaker_name}", speaker_name or "")
    text = text.replace("{speaker_topic}", speaker_topic or "")
    text = text.replace("{stream_url}", stream_url_val or "")
    return text.strip()


# ─── Формирование текста: дневные шаблоны ───────────────────────────────────

def build_day_message(tmpl_text, day_number, conf_title, day_date, day_program,
                      stream_url_val, registration_url_val, raffle_url_val="", day_speakers_gifts="",
                      next_day_mention="", day_title="", day_datetime=""):
    text = tmpl_text or ""
    ordinal = ORDINALS.get(day_number, f"{day_number}-м")
    text = text.replace("{day_number}", str(day_number))
    text = text.replace("{day_ordinal}", ordinal)
    # {day_title} — кастомное название дня (conf_days.title), fallback «День N».
    text = text.replace("{day_title}", (day_title or "").strip() or f"День {day_number}")
    text = text.replace("{conf_title}", conf_title or "")
    # {day_datetime} — дата + время старта (для мероприятий: «5 июня в 12:06 МСК»).
    # fallback на дату без времени, если время неизвестно.
    text = text.replace("{day_datetime}", (day_datetime or "").strip() or (day_date or ""))
    text = text.replace("{day_date}", day_date or "")
    text = text.replace("{day_program}", day_program or "")
    text = text.replace("{stream_url}", stream_url_val or "")
    text = text.replace("{landing_url}", registration_url_val or "")
    text = text.replace("{registration_url}", registration_url_val or "")
    text = text.replace("{raffle_url}", raffle_url_val or "")
    text = text.replace("{day_speakers_gifts}", day_speakers_gifts or "")
    if next_day_mention:
        text = text.replace("{next_day_mention}", next_day_mention)
    else:
        text = re.sub(r"^.*\{next_day_mention\}.*$\n?", "", text, flags=re.MULTILINE)
    if not day_speakers_gifts:
        text = re.sub(r"^.*\{day_speakers_gifts\}.*$\n?", "", text, flags=re.MULTILINE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ─── ЕДИНАЯ функция сборки контента сообщения ───────────────────────────────

async def get_default_event_photo(conn, event_id: int) -> Optional[str]:
    """
    Дефолтная афиша события для рассылок: лучшая из event_posters
    с приоритетом square > horizontal > vertical. Используется как
    fallback, когда в шаблоне рассылки photo_url не задан клиентом.
    """
    return await conn.fetchval(
        """SELECT url FROM event_posters
            WHERE event_id = $1
            ORDER BY CASE orientation
                       WHEN 'square'     THEN 1
                       WHEN 'horizontal' THEN 2
                       WHEN 'vertical'   THEN 3
                       ELSE 4
                     END, sort, id
            LIMIT 1""",
        event_id
    )


async def build_message_content(conn, tpl_type: str, tmpl_text: str, photo_url, btn_text, btn_url: str,
                                 event_id: int, session_id, fire_at, tz: ZoneInfo,
                                 template_id=None, snapshot=None,
                                 video_url=None, media_type=None) -> dict:
    """
    Единственная функция сборки текста, фото/видео и кнопки для любого типа шаблона.
    Используется и в Celery (broadcast.py) и в превью (broadcasts.py).

    Для type='custom' данные берутся из `snapshot`:
      {text, photo, video, media_type, buttons:[{text,url},...]}
    и возвращаются как есть (с подстановкой {first_name} на уровне Celery).

    `video`/`media_type` в ответе:
      - media_type='video' → media лежит в `video` (Telegram шлёт встроенным плеером);
      - media_type='photo' (или фото без media_type) → media в `photo`.
    """
    # ── custom: произвольное сообщение без шаблона ─────────────────────────
    if tpl_type == "custom":
        snap = snapshot or {}
        raw_text = (snap.get("text") or tmpl_text or "").strip()
        raw_text = re.sub(r"\n{3,}", "\n\n", raw_text)
        raw_buttons = snap.get("buttons") or []
        snap_mtype = snap.get("media_type")
        snap_video = snap.get("video")
        snap_photo = snap.get("photo")
        # Если media_type не задан (старые записи) — выводим из наличия URL.
        if not snap_mtype:
            snap_mtype = "video" if snap_video else ("photo" if snap_photo else None)
        # {vip_url} — ссылка на оплату VIP-тарифа (events.vip_url), и в тексте, и в кнопках.
        if "{vip_url}" in raw_text or any("{vip_url}" in (b.get("url") or "") for b in raw_buttons):
            vip_url = await conn.fetchval(
                "SELECT vip_url FROM events WHERE id=$1", event_id
            ) or ""
            raw_text = raw_text.replace("{vip_url}", vip_url)
            if not vip_url:
                raw_text = re.sub(r"^.*\{vip_url\}.*$\n?", "", raw_text, flags=re.MULTILINE)
            raw_buttons = [{**b, "url": (b.get("url") or "").replace("{vip_url}", vip_url)} for b in raw_buttons]
        return {
            "text": raw_text,
            "photo": (snap_photo or photo_url) if snap_mtype != "video" else None,
            "video": snap_video if snap_mtype == "video" else None,
            "media_type": snap_mtype,
            "button_text": None,
            "button_url": None,
            "buttons": raw_buttons,
        }

    text = tmpl_text or ""
    photo = photo_url
    btn_url = btn_url or ""

    if tpl_type in DAY_TYPES:
        # Определяем номер дня по fire_at (МСК-дата дня в conf_days.day_date).
        # Для НЕ-конференций conf_days отсутствует — день всегда 1.
        day = 1
        if fire_at:
            fire_local = fire_at.astimezone(ZoneInfo("Europe/Moscow"))
            fire_date = fire_local.date()
            day_row = await conn.fetchrow(
                "SELECT day_number FROM conf_days WHERE event_id=$1 AND day_date=$2",
                event_id, fire_date
            )
            if day_row:
                day = day_row["day_number"]

        # JOIN conf_conferences — LEFT, чтобы не-конференции тоже отдавали title/dates.
        # day_date берём из conf_days (если конференция) или из events.start_at (МСК).
        conf_row = await conn.fetchrow(
            """
            SELECT e.title as conf_title,
                   e.module_slug,
                   e.landing_url AS registration_url,
                   cc.raffle_url,
                   e.stream_url,
                   cd.title AS day_title,
                   COALESCE(cd.day_date,
                            (e.start_at AT TIME ZONE 'Europe/Moscow')::date) AS day_date,
                   (e.start_at AT TIME ZONE 'Europe/Moscow') AS event_start_msk
            FROM events e
            LEFT JOIN conf_conferences cc ON cc.event_id = e.id
            LEFT JOIN conf_days cd ON cd.event_id = e.id AND cd.day_number = $2
            WHERE e.id = $1
            """,
            event_id, day
        )
        conf_title = (conf_row["conf_title"] or "") if conf_row else ""
        # «Событие с программой по дням» — конференция ИЛИ турнир (оба используют conf_days).
        is_program_event = (conf_row["module_slug"] in ("conference", "turnir")) if conf_row else False
        is_conference = (conf_row["module_slug"] == "conference") if conf_row else False
        stream_url = (conf_row["stream_url"] or "") if conf_row else ""
        reg_url = (conf_row["registration_url"] or "") if conf_row else ""
        # У мероприятия (нет программы по дням) часто не задан landing_url, но есть
        # stream_url (вебинарная комната). Тогда {landing_url}/{registration_url} и
        # кнопка «Зарегистрироваться» ведут прямо в комнату — иначе кнопка с пустым
        # URL не создаётся в Telegram и сообщение уходит вообще без кнопки.
        if not reg_url and not is_program_event and stream_url:
            reg_url = stream_url
        raffle_url = (conf_row["raffle_url"] or "") if conf_row else ""
        raw_date = conf_row["day_date"] if conf_row else None
        day_title = (conf_row["day_title"] or "") if conf_row else ""
        day_date_str = f"{raw_date.day} {RU_MONTHS[raw_date.month - 1]}" if raw_date else (f"День {day}" if is_program_event else "")
        # {day_datetime} — дата + время старта. Для мероприятия (нет программы по
        # дням) время берём из events.start_at; «5 июня в 12:06 МСК». Для конф/
        # турнира start_at обычно пуст — fallback на дату дня без времени.
        event_start_msk = conf_row["event_start_msk"] if conf_row else None
        if event_start_msk and not is_program_event:
            day_datetime_str = (f"{event_start_msk.day} {RU_MONTHS[event_start_msk.month - 1]} "
                                f"в {event_start_msk.strftime('%H:%M')} МСК")
        else:
            day_datetime_str = day_date_str
        if not photo:
            photo = await get_default_event_photo(conn, event_id)

        # Программа дня — у событий с программой (конференция/турнир). У мероприятий conf_sessions пуст.
        day_sessions = await conn.fetch(
            """
            SELECT cs.start_time, cs.end_time,
                   COALESCE(cst.topic, cs.title) as session_title,
                   c.name as speaker_name, cse.role
            FROM conf_sessions cs
            LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
            LEFT JOIN collaborators c ON c.id = cse.speaker_id
            LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
            WHERE cs.event_id=$1 AND cs.day=$2
            ORDER BY cs.sort_order, cs.start_time
            """,
            event_id, day
        ) if is_program_event else []
        program_lines = []
        for s in day_sessions:
            t_start = _fmt_time(s["start_time"])
            t_end = _fmt_time(s["end_time"])
            if t_start and t_end:
                time_part = f"{t_start}–{t_end} МСК"
            elif t_start:
                time_part = f"{t_start} МСК"
            else:
                time_part = ""
            bold_time = f"<b>{time_part}</b>" if time_part else ""
            topic = s["session_title"] or ""
            name = s["speaker_name"] or ""
            role_label = ROLE_LABELS_DAY.get(s["role"] or "", "")
            speaker_part = f" (<b>{name}{' — ' + role_label if role_label else ''}</b>)" if name else ""
            program_lines.append(f"{bold_time}: {topic}{speaker_part}".strip(": "))
        day_program = "\n".join(program_lines)

        day_speakers_gifts = ""
        next_day_mention = ""
        if tpl_type == "day_end":
            gift_sessions = await conn.fetch(
                """
                SELECT c.name as speaker_name,
                       pu_tg.username AS personal_tg_username,
                       cse.gift_after_speech_title, cse.gift_after_speech_url, cse.role, cse.is_commercial
                FROM conf_sessions cs
                JOIN event_collaborators cse ON cse.id = cs.speaker_id
                JOIN collaborators c ON c.id = cse.speaker_id
                LEFT JOIN platform_users pu_tg
                  ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
                WHERE cs.event_id=$1 AND cs.day=$2
                  AND cse.exclude_gift_from_broadcast = FALSE
                ORDER BY """ + collaborator_sort.order_by_sql("cse") + """, cs.sort_order
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

            first_next = await conn.fetchrow(
                """SELECT cs.start_time, d.day_date
                     FROM conf_sessions cs
                     LEFT JOIN conf_days d ON d.event_id = cs.event_id AND d.day_number = cs.day
                    WHERE cs.event_id=$1 AND cs.day=$2 AND cs.start_time IS NOT NULL
                    ORDER BY cs.sort_order, cs.start_time LIMIT 1""",
                event_id, day + 1
            )
            first_cur = await conn.fetchrow(
                """SELECT d.day_date
                     FROM conf_sessions cs
                     LEFT JOIN conf_days d ON d.event_id = cs.event_id AND d.day_number = cs.day
                    WHERE cs.event_id=$1 AND cs.day=$2
                    ORDER BY cs.sort_order, cs.start_time LIMIT 1""",
                event_id, day
            )
            if first_next and first_next["start_time"]:
                next_time = _fmt_time(first_next["start_time"])
                next_date = first_next["day_date"]
                cur_date = first_cur["day_date"] if first_cur else None
                diff = (next_date - cur_date).days if (next_date and cur_date) else 999
                when = "завтра" if diff == 1 else (f"{next_date.day} {RU_MONTHS[next_date.month - 1]}" if next_date else "")
                next_day_mention = f"Встречаемся {when} в {next_time} МСК на День {day + 1}."

        text = build_day_message(text, day, conf_title, day_date_str, day_program,
                                  stream_url, reg_url, raffle_url, day_speakers_gifts, next_day_mention,
                                  day_title=day_title, day_datetime=day_datetime_str)
        btn_url = (btn_url
                   .replace("{stream_url}", stream_url)
                   .replace("{landing_url}", reg_url)
                   .replace("{registration_url}", reg_url)
                   .replace("{raffle_url}", raffle_url))

    elif tpl_type == "speaker_intro":
        if session_id:
            sp = await conn.fetchrow(
                """
                SELECT c.name as speaker_name,
                       (SELECT url FROM collaborator_posters cp
                          WHERE cp.id = cse.poster_id OR
                                (cse.poster_id IS NULL AND cp.collaborator_id = c.id)
                          ORDER BY (cp.id = cse.poster_id) DESC, cp.sort_order, cp.id
                          LIMIT 1) as speaker_poster,
                       c.photo_url AS speaker_photo,
                       pu_tg.username AS personal_tg_username,
                       c.tg_channel_url, c.instagram_url,
                       c.achievements,
                       cse.role, cse.gift_after_speech_title, cse.gift_after_speech_url,
                       cse.gift_raffle_title,
                       e.landing_url AS registration_url
                FROM event_collaborators cse
                JOIN collaborators c ON c.id = cse.speaker_id
                JOIN events e ON e.id = cse.event_id
                LEFT JOIN platform_users pu_tg
                  ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
                WHERE cse.id=$1
                """,
                session_id
            )
            if sp:
                topics = await conn.fetch(
                    "SELECT topic FROM conf_speaker_topics WHERE cse_id=$1 ORDER BY sort_order",
                    session_id
                )
                # Все темы спикера через перенос строки (а не первая) —
                # у спикеров с темами по дням было видно только одну.
                topic = "\n".join((t["topic"] or "").strip() for t in topics if (t["topic"] or "").strip())
                # Приоритет фото: фото шаблона → индивидуальная афиша спикера →
                # фото коллаборатора (аватар). Афиша события для speaker_intro НЕ
                # подставляется — у спикера всегда есть хотя бы фото профиля.
                if not photo:
                    photo = sp["speaker_poster"] or sp["speaker_photo"]
                text = build_speaker_intro_message(
                    text, sp["speaker_name"], sp["personal_tg_username"],
                    sp["tg_channel_url"], sp["instagram_url"],
                    sp["achievements"], sp["role"],
                    topic, sp["gift_after_speech_title"],
                    sp["gift_raffle_title"], sp["registration_url"]
                )
                reg_url = sp["registration_url"] or ""
                btn_url = (btn_url
                           .replace("{landing_url}", reg_url)
                           .replace("{registration_url}", reg_url))

    elif tpl_type in ("5min_before", "gift"):
        session_data = {}
        if session_id:
            session = await conn.fetchrow(
                """
                SELECT cs.title as session_title, cs.start_time, cs.end_time, cs.day,
                       c.name as speaker_name,
                       (SELECT url FROM collaborator_posters cp
                          WHERE cp.id = cse.poster_id OR
                                (cse.poster_id IS NULL AND cp.collaborator_id = c.id)
                          ORDER BY (cp.id = cse.poster_id) DESC, cp.sort_order, cp.id
                          LIMIT 1) as speaker_poster,
                       pu_tg.username as speaker_personal_tg,
                       cst.topic as speaker_topic,
                       cse.gift_after_speech_title as gift_title,
                       cse.gift_after_speech_url as gift_url,
                       cse.gift_lead_magnet_id, cse.gift_package_id,
                       lm.name AS lm_name, lm.url AS lm_url,
                       lp.name AS lp_name, lp.slug AS lp_slug,
                       e.stream_url
                FROM conf_sessions cs
                LEFT JOIN events e ON e.id = cs.event_id
                LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
                LEFT JOIN collaborators c ON c.id = cse.speaker_id
                LEFT JOIN platform_users pu_tg
                  ON pu_tg.contact_id = c.contact_id AND pu_tg.platform_slug = 'telegram'
                LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
                LEFT JOIN lead_magnets lm ON lm.id = cse.gift_lead_magnet_id
                LEFT JOIN lead_magnet_packages lp ON lp.id = cse.gift_package_id
                WHERE cs.id=$1
                """,
                session_id
            )
            if session:
                session_data = dict(session)
                # Подарок: приоритет ручному вводу; иначе берём из ПЛЮСОНа
                # (лид-магнит → его название+ссылка; пакет → название+ссылка /p/{slug}).
                if not session_data.get("gift_title"):
                    if session_data.get("lm_name"):
                        session_data["gift_title"] = session_data["lm_name"]
                        session_data["gift_url"] = session_data.get("lm_url") or session_data.get("gift_url")
                    elif session_data.get("lp_name"):
                        session_data["gift_title"] = session_data["lp_name"]
                        if session_data.get("lp_slug"):
                            session_data["gift_url"] = f"https://pluson.ru/p/{session_data['lp_slug']}"
        if not photo:
            photo = session_data.get("speaker_poster")
        stream_url = session_data.get("stream_url") or ""
        if tpl_type == "gift":
            text = build_gift_message(
                session_data.get("speaker_name"),
                session_data.get("speaker_personal_tg"),
                session_data.get("gift_title"),
                session_data.get("gift_url"),
                tmpl_text=tmpl_text,
            )
        else:  # 5min_before
            text = build_pre_start_message(
                text,
                session_data.get("speaker_name"),
                session_data.get("speaker_topic") or session_data.get("session_title"),
                stream_url,
            )
        btn_url = btn_url.replace("{stream_url}", stream_url)

    elif tpl_type == "pre_conf":
        conf_row = await conn.fetchrow(
            """
            SELECT e.title as conf_title, e.description as conf_description,
                   e.landing_url AS registration_url,
                   cd.day_date
            FROM events e
            JOIN conf_conferences cc ON cc.event_id = e.id
            LEFT JOIN conf_days cd ON cd.event_id = e.id AND cd.day_number = 1
            WHERE e.id = $1
            """,
            event_id
        )
        conf_title = (conf_row["conf_title"] or "") if conf_row else ""
        conf_desc = html_to_telegram((conf_row["conf_description"] or "") if conf_row else "")
        reg_url = (conf_row["registration_url"] or "") if conf_row else ""
        raw_date = conf_row["day_date"] if conf_row else None
        conf_date_str = f"{raw_date.day} {RU_MONTHS[raw_date.month - 1]}" if raw_date else ""
        if not photo:
            photo = await get_default_event_photo(conn, event_id)
        text = text.replace("{conf_title}", conf_title)
        text = text.replace("{conf_description}", conf_desc)
        text = text.replace("{conf_date}", conf_date_str)
        text = text.replace("{landing_url}", reg_url)
        text = text.replace("{registration_url}", reg_url)
        btn_url = (btn_url
                   .replace("{landing_url}", reg_url)
                   .replace("{registration_url}", reg_url))

    elif tpl_type == "custom":
        # Кастомный шаблон. Определяем день конференции по fire_at (если матчится дата)
        # или по custom_day_ref шаблона; подставляем все «конференционные» плейсхолдеры.
        custom_day_ref = None
        if template_id:
            row = await conn.fetchrow(
                "SELECT custom_day_ref FROM broadcast_templates WHERE id=$1", template_id
            )
            custom_day_ref = row["custom_day_ref"] if row else None

        conf_days_rows = await conn.fetch(
            "SELECT day_number, day_date FROM conf_days WHERE event_id=$1 ORDER BY day_number",
            event_id
        )
        days_by_num = {d["day_number"]: d for d in conf_days_rows}
        first_day = conf_days_rows[0] if conf_days_rows else None
        last_day = conf_days_rows[-1] if conf_days_rows else None
        # Один stream_url на всю конференцию — теперь хранится в events
        event_stream_url = await conn.fetchval(
            "SELECT stream_url FROM events WHERE id=$1", event_id
        ) or ""

        # Определяем «целевой» день для плейсхолдеров
        target_day_num = None
        if fire_at:
            fire_date = fire_at.astimezone(tz).date()
            for d in conf_days_rows:
                if d["day_date"] == fire_date:
                    target_day_num = d["day_number"]
                    break
        if target_day_num is None and custom_day_ref:
            if custom_day_ref.startswith("before_"):
                target_day_num = first_day["day_number"] if first_day else 1
            elif custom_day_ref.startswith("day_"):
                try:
                    target_day_num = int(custom_day_ref.split("_", 1)[1])
                except Exception:
                    pass
            elif custom_day_ref.startswith("after_"):
                target_day_num = last_day["day_number"] if last_day else 1

        target_day = days_by_num.get(target_day_num) if target_day_num else None

        conf_row = await conn.fetchrow(
            """
            SELECT e.title as conf_title, e.description as conf_description,
                   e.landing_url AS registration_url, cc.raffle_url
            FROM events e
            JOIN conf_conferences cc ON cc.event_id = e.id
            WHERE e.id=$1
            """,
            event_id
        )
        conf_title = (conf_row["conf_title"] or "") if conf_row else ""
        conf_desc = html_to_telegram((conf_row["conf_description"] or "") if conf_row else "")
        reg_url = (conf_row["registration_url"] or "") if conf_row else ""
        raffle_url = (conf_row["raffle_url"] or "") if conf_row else ""

        raw_first_date = first_day["day_date"] if first_day else None
        conf_date_str = f"{raw_first_date.day} {RU_MONTHS[raw_first_date.month - 1]}" if raw_first_date else ""

        day_number = target_day_num or (first_day["day_number"] if first_day else 1)
        raw_day_date = target_day["day_date"] if target_day else raw_first_date
        day_date_str = f"{raw_day_date.day} {RU_MONTHS[raw_day_date.month - 1]}" if raw_day_date else ""
        stream_url = event_stream_url

        # Программа дня — только если есть привязка к конкретному дню
        day_program = ""
        if target_day_num:
            day_sessions = await conn.fetch(
                """
                SELECT cs.start_time, cs.end_time,
                       COALESCE(cst.topic, cs.title) as session_title,
                       c.name as speaker_name, cse.role
                FROM conf_sessions cs
                LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
                LEFT JOIN collaborators c ON c.id = cse.speaker_id
                LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
                WHERE cs.event_id=$1 AND cs.day=$2
                ORDER BY cs.sort_order, cs.start_time
                """,
                event_id, target_day_num
            )
            program_lines = []
            for s in day_sessions:
                t_start = _fmt_time(s["start_time"])
                t_end = _fmt_time(s["end_time"])
                if t_start and t_end:
                    time_part = f"{t_start}–{t_end} МСК"
                elif t_start:
                    time_part = f"{t_start} МСК"
                else:
                    time_part = ""
                bold_time = f"<b>{time_part}</b>" if time_part else ""
                topic = s["session_title"] or ""
                name = s["speaker_name"] or ""
                role_label = ROLE_LABELS_DAY.get(s["role"] or "", "")
                speaker_part = f" (<b>{name}{' — ' + role_label if role_label else ''}</b>)" if name else ""
                program_lines.append(f"{bold_time}: {topic}{speaker_part}".strip(": "))
            day_program = "\n".join(program_lines)

        if not photo:
            photo = await get_default_event_photo(conn, event_id)

        ordinal = ORDINALS.get(day_number, f"{day_number}-м")
        text = text.replace("{conf_title}", conf_title)
        text = text.replace("{conf_description}", conf_desc)
        text = text.replace("{conf_date}", conf_date_str)
        text = text.replace("{day_number}", str(day_number))
        text = text.replace("{day_ordinal}", ordinal)
        text = text.replace("{day_date}", day_date_str)
        text = text.replace("{day_program}", day_program)
        text = text.replace("{stream_url}", stream_url)
        text = text.replace("{landing_url}", reg_url)
        text = text.replace("{registration_url}", reg_url)
        text = text.replace("{raffle_url}", raffle_url)

        # Убираем незамененные строки с плейсхолдерами, если значение пустое
        if not day_program:
            text = re.sub(r"^.*\{day_program\}.*$\n?", "", text, flags=re.MULTILINE)
        if not stream_url:
            text = re.sub(r"^.*\{stream_url\}.*$\n?", "", text, flags=re.MULTILINE)

        btn_url = (btn_url
                   .replace("{stream_url}", stream_url)
                   .replace("{landing_url}", reg_url)
                   .replace("{registration_url}", reg_url)
                   .replace("{raffle_url}", raffle_url))

    else:
        text = tmpl_text or ""

    # ── {vip_url} — ссылка на оплату VIP-тарифа (events.vip_url) ──────────────
    # Единая подстановка для ВСЕХ типов шаблонов: и в тексте, и в кнопке.
    # Источник — events.vip_url (та же ссылка, что у VIP-кнопки в Mini App).
    if "{vip_url}" in text or "{vip_url}" in (btn_url or ""):
        vip_url = await conn.fetchval(
            "SELECT vip_url FROM events WHERE id=$1", event_id
        ) or ""
        text = text.replace("{vip_url}", vip_url)
        btn_url = (btn_url or "").replace("{vip_url}", vip_url)
        # Если ссылка пустая — убираем строку с висящим плейсхолдером.
        if not vip_url:
            text = re.sub(r"^.*\{vip_url\}.*$\n?", "", text, flags=re.MULTILINE)

    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    # Для шаблонов media_type='video' → отдаём видео (фото игнорируем).
    tpl_mtype = (media_type or "").strip().lower() or None
    if tpl_mtype == "video" and video_url:
        return {
            "text": text,
            "photo": None,
            "video": video_url,
            "media_type": "video",
            "button_text": btn_text,
            "button_url": btn_url or None,
        }

    return {
        "text": text,
        "photo": photo,
        "video": None,
        "media_type": "photo" if photo else None,
        "button_text": btn_text,
        "button_url": btn_url or None,
    }


# ─── Отправка в Telegram ─────────────────────────────────────────────────────

# Лимит Telegram на caption под видео = 1024 символа. Длиннее — видео без
# подписи + текст отдельным сообщением.
TG_VIDEO_CAPTION_LIMIT = 1024


# Кеш скачанных с R2 байт видео — в пределах одной рассылки прогрев качает
# файл максимум один раз (на первого получателя), дальше шлём по file_id.
_VIDEO_BYTES_CACHE: dict[str, bytes] = {}
# Кеш метаданных видео (width, height, duration) и обложки-JPEG по URL —
# чтобы ffprobe/ffmpeg отработали один раз на рассылку, а не на каждого.
_VIDEO_META_CACHE: dict[str, dict] = {}


async def _tg_send_video(
    client: httpx.AsyncClient,
    bot_token: str,
    chat_id: str,
    text: str,
    reply_markup: dict | None,
    video_url: str,
    video_file_id: str | None,
    on_video_file_id=None,
) -> tuple[bool, str]:
    """Отправляет видео в Telegram со встроенным плеером.

    Порядок:
      1) если есть video_file_id — sendVideo по file_id (мгновенно, JSON);
      2) иначе/при неудаче — СКАЧИВАЕМ файл с R2 и грузим в Telegram
         multipart-ом (sendVideo с file=...). Это надёжный путь: Telegram
         плохо умеет тянуть видео по URL (часто `wrong type of the web page
         content`), а байты принимает всегда. Из ответа достаём file_id и
         кешируем через колбэк — следующим получателям уйдёт мгновенно.

    Возвращает (успех, ошибка). При полной неудаче — caller сделает fallback
    на текст+ссылку."""
    caption = text if (text and len(text) <= TG_VIDEO_CAPTION_LIMIT) else None
    long_text = text if (text and len(text) > TG_VIDEO_CAPTION_LIMIT) else None

    def _common_fields() -> dict:
        d = {"chat_id": chat_id, "supports_streaming": "true"}
        if caption:
            d["caption"] = caption
            d["parse_mode"] = "HTML"
        if reply_markup and not long_text:
            import json as _j
            d["reply_markup"] = _j.dumps(reply_markup)
        return d

    async def _send_by_file_id(fid: str) -> tuple[bool, str, str | None]:
        payload = {"chat_id": chat_id, "video": fid, "supports_streaming": True}
        if caption:
            payload["caption"] = caption
            payload["parse_mode"] = "HTML"
        if reply_markup and not long_text:
            payload["reply_markup"] = reply_markup
        try:
            r = await client.post(f"https://api.telegram.org/bot{bot_token}/sendVideo", json=payload, timeout=60)
            data = r.json()
            if data.get("ok"):
                return True, "", (data.get("result", {}).get("video") or {}).get("file_id")
            return False, data.get("description", f"HTTP {r.status_code}"), None
        except Exception as e:
            return False, str(e), None

    async def _ensure_meta(content: bytes) -> dict:
        """Считает (один раз на URL) размеры/длительность и обложку видео —
        чтобы Telegram показал правильные пропорции и постер."""
        meta = _VIDEO_META_CACHE.get(video_url)
        if meta is not None:
            return meta
        meta = {"w": None, "h": None, "dur": None, "thumb": None}
        try:
            from app.services.video_meta import probe_dimensions, extract_thumbnail
            dims = await probe_dimensions(content)
            if dims:
                meta["w"], meta["h"], meta["dur"] = dims
            meta["thumb"] = await extract_thumbnail(content)
        except Exception as e:
            logger.warning(f"video meta extraction failed: {e}")
        _VIDEO_META_CACHE[video_url] = meta
        return meta

    async def _send_multipart() -> tuple[bool, str, str | None]:
        # Скачиваем байты (с кешем на время рассылки).
        content = _VIDEO_BYTES_CACHE.get(video_url)
        if content is None:
            try:
                rr = await client.get(video_url, timeout=180)
                if rr.status_code != 200:
                    return False, f"R2 GET {rr.status_code}", None
                content = rr.content
                _VIDEO_BYTES_CACHE[video_url] = content
            except Exception as e:
                return False, f"download: {e}", None
        meta = await _ensure_meta(content)
        fields = _common_fields()
        if meta.get("w") and meta.get("h"):
            fields["width"] = str(meta["w"])
            fields["height"] = str(meta["h"])
        if meta.get("dur"):
            fields["duration"] = str(meta["dur"])
        files = {"video": ("video.mp4", content, "video/mp4")}
        if meta.get("thumb"):
            # Telegram: обложку прикладываем файлом и ссылаемся через attach://
            files["thumbnail"] = ("thumb.jpg", meta["thumb"], "image/jpeg")
            fields["thumbnail"] = "attach://thumbnail"
        try:
            r = await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendVideo",
                data=fields,
                files=files,
                timeout=180,
            )
            data = r.json()
            if data.get("ok"):
                return True, "", (data.get("result", {}).get("video") or {}).get("file_id")
            return False, data.get("description", f"HTTP {r.status_code}"), None
        except Exception as e:
            return False, str(e), None

    ok, err, fid = (False, "", None)
    # 1) сначала file_id, если есть
    if video_file_id:
        ok, err, fid = await _send_by_file_id(video_file_id)
    # 2) иначе/при неудаче — multipart (надёжно)
    if not ok:
        ok, err, fid = await _send_multipart()
    if ok and fid and on_video_file_id:
        try:
            on_video_file_id(fid)
        except Exception:
            pass

    if not ok:
        return False, err

    # Текст не влез в caption — досылаем отдельным сообщением с кнопкой.
    if long_text:
        payload = {"chat_id": chat_id, "text": long_text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if reply_markup:
            payload["reply_markup"] = reply_markup
        try:
            await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
        except Exception:
            pass
    return True, ""


async def send_telegram_message(
    client: httpx.AsyncClient,
    bot_token: str,
    chat_id: str,
    text: str,
    photo_url: str = None,
    button_text: str = None,
    button_url: str = None,
    buttons: list = None,
    _retry: int = 0,
    video_url: str = None,
    video_file_id: str = None,
    on_video_file_id=None,
) -> tuple[bool, str]:
    """Отправляет сообщение через Telegram Bot API.
    - Если передан `buttons` (список {text, url}) — используется он (по одной в ряду, до 3).
    - Иначе, если есть `button_text`+`button_url` — одиночная inline-кнопка (совместимость).

    Видео (`video_url`): шлём через sendVideo — Telegram показывает встроенный плеер.
    Чтобы не качать файл с R2 на каждого получателя, первый успешный sendVideo
    возвращает file_id; передавайте его следующим вызовам через `video_file_id`.
    `on_video_file_id(fid)` — колбэк для сохранения свежего file_id (вызовется один раз).
    Если sendVideo не прошёл (видео не принято/слишком большое) — fallback: ссылка
    на видео добавляется в текст и уходит обычным sendMessage. Так доставка
    гарантирована.

    Возвращает (успех, описание_ошибки).
    """
    try:
        reply_markup = None
        btn_rows = []
        if buttons:
            for b in buttons:
                t = (b.get("text") or "").strip() if isinstance(b, dict) else ""
                u = (b.get("url") or "").strip() if isinstance(b, dict) else ""
                if t and u:
                    btn_rows.append([{"text": t, "url": u}])
                if len(btn_rows) >= 3:
                    break
        elif button_text and button_url:
            btn_rows.append([{"text": button_text, "url": button_url}])
        if btn_rows:
            reply_markup = {"inline_keyboard": btn_rows}

        # ── Видео: sendVideo со встроенным плеером (с кешем file_id) ──
        if video_url:
            ok, err = await _tg_send_video(
                client, bot_token, chat_id, text, reply_markup,
                video_url, video_file_id, on_video_file_id,
            )
            if ok:
                return True, ""
            # sendVideo не прошёл — fallback на текст со ссылкой, доставка важнее.
            logger.warning(f"sendVideo не прошёл ({err}) — fallback на текст+ссылку для {chat_id}")
            link_text = f"{text}\n\n🎬 Видео: {video_url}" if text else video_url
            payload = {"chat_id": chat_id, "text": link_text, "parse_mode": "HTML", "disable_web_page_preview": False}
            if reply_markup:
                payload["reply_markup"] = reply_markup
            resp = await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
            if resp.status_code == 200:
                return True, ""
            err2 = resp.json().get("description", f"HTTP {resp.status_code}")
            return False, err2

        if photo_url and len(text) <= 1024:
            payload = {"chat_id": chat_id, "photo": photo_url, "caption": text, "parse_mode": "HTML"}
            if reply_markup:
                payload["reply_markup"] = reply_markup
            resp = await client.post(f"https://api.telegram.org/bot{bot_token}/sendPhoto", json=payload)
        elif photo_url:
            await client.post(f"https://api.telegram.org/bot{bot_token}/sendPhoto",
                              json={"chat_id": chat_id, "photo": photo_url})
            payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
            if reply_markup:
                payload["reply_markup"] = reply_markup
            resp = await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)
        else:
            payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
            if reply_markup:
                payload["reply_markup"] = reply_markup
            resp = await client.post(f"https://api.telegram.org/bot{bot_token}/sendMessage", json=payload)

        if resp.status_code == 200:
            return True, ""
        # Авторетрай при 429 (Too Many Requests) — Telegram говорит сколько ждать
        if resp.status_code == 429 and _retry < 1:
            try:
                retry_after = int(resp.json().get("parameters", {}).get("retry_after") or 0)
            except Exception:
                retry_after = 0
            wait = min(max(retry_after, 1), 60)
            import asyncio as _a
            await _a.sleep(wait)
            return await send_telegram_message(
                client, bot_token, chat_id, text, photo_url, button_text, button_url,
                buttons=buttons, _retry=_retry + 1
            )
        err = resp.json().get("description", f"HTTP {resp.status_code}")
        logger.warning(f"Telegram отклонил сообщение в {chat_id}: {err}")
        return False, err
    except Exception as e:
        logger.warning(f"Ошибка отправки в {chat_id}: {e}")
        return False, str(e)
