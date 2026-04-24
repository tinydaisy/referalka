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
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

RU_MONTHS = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"]

ROLE_LABELS_INTRO = {
    "speaker": "Спикер",
    "headliner": "Хедлайнер",
    "partner": "Партнёр",
    "organizer": "Организатор",
}

ORDINALS = {1: "первом", 2: "втором", 3: "третьем", 4: "четвёртом", 5: "пятом"}
ROLE_LABELS_DAY = {"headliner": "Хедлайнер", "partner": "Партнёр", "organizer": "Организатор"}

DAY_TYPES = ("day_start_30min_unreg", "day_start_30min_reg", "day_live", "day_end")
SPEAKER_TYPES = ("gift", "speaker_intro", "pre_start")
CONF_TYPES = ("pre_conf",)


def _fmt_time(dt) -> str:
    if not dt:
        return ""
    if isinstance(dt, datetime):
        return dt.strftime("%H:%M")
    return str(dt)


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
    if not day_speakers_gifts:
        text = re.sub(r"^.*\{day_speakers_gifts\}.*$\n?", "", text, flags=re.MULTILINE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ─── ЕДИНАЯ функция сборки контента сообщения ───────────────────────────────

async def build_message_content(conn, tpl_type: str, tmpl_text: str, photo_url, btn_text, btn_url: str,
                                 event_id: int, session_id, fire_at, tz: ZoneInfo,
                                 template_id=None, snapshot=None) -> dict:
    """
    Единственная функция сборки текста, фото и кнопки для любого типа шаблона.
    Используется и в Celery (broadcast.py) и в превью (broadcasts.py).

    Для type='custom' данные берутся из `snapshot`: {text, photo, buttons:[{text,url},...]}
    и возвращаются как есть (с подстановкой {first_name} на уровне Celery).
    """
    # ── custom: произвольное сообщение без шаблона ─────────────────────────
    if tpl_type == "custom":
        snap = snapshot or {}
        raw_text = (snap.get("text") or tmpl_text or "").strip()
        raw_text = re.sub(r"\n{3,}", "\n\n", raw_text)
        raw_buttons = snap.get("buttons") or []
        return {
            "text": raw_text,
            "photo": snap.get("photo") or photo_url,
            "button_text": None,
            "button_url": None,
            "buttons": raw_buttons,
        }

    text = tmpl_text or ""
    photo = photo_url
    btn_url = btn_url or ""

    if tpl_type in DAY_TYPES:
        # Определяем номер дня по fire_at
        day = 1
        if fire_at:
            fire_local = fire_at.astimezone(tz)
            fire_date = fire_local.date()
            day_row = await conn.fetchrow(
                """
                SELECT cs.day FROM conf_sessions cs
                WHERE cs.event_id=$1 AND DATE(cs.start_datetime AT TIME ZONE $2) = $3
                ORDER BY cs.start_datetime LIMIT 1
                """,
                event_id, str(tz), fire_date
            )
            if day_row:
                day = day_row["day"]

        conf_row = await conn.fetchrow(
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
        day_date_str = f"{raw_date.day} {RU_MONTHS[raw_date.month - 1]}" if raw_date else f"День {day}"
        poster_h = conf_row["poster_horizontal"] if conf_row else None
        if not photo and poster_h:
            photo = poster_h[0] if isinstance(poster_h, list) else poster_h

        day_sessions = await conn.fetch(
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
            role_label = ROLE_LABELS_DAY.get(s["role"] or "", "")
            speaker_part = f" (<b>{name}{' — ' + role_label if role_label else ''}</b>)" if name else ""
            program_lines.append(f"{bold_time}: {topic}{speaker_part}".strip(": "))
        day_program = "\n".join(program_lines)

        day_speakers_gifts = ""
        next_day_mention = ""
        if tpl_type == "day_end":
            gift_sessions = await conn.fetch(
                """
                SELECT c.name as speaker_name, c.personal_tg_username,
                       cse.gift_after_speech_title, cse.gift_after_speech_url, cse.role, cse.is_commercial
                FROM conf_sessions cs
                JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                JOIN collaborators c ON c.id = cse.speaker_id
                WHERE cs.event_id=$1 AND cs.day=$2
                  AND cse.exclude_gift_from_broadcast = FALSE
                ORDER BY cse.priority, cs.sort_order
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
                "SELECT start_datetime FROM conf_sessions WHERE event_id=$1 AND day=$2 ORDER BY sort_order, start_datetime LIMIT 1",
                event_id, day + 1
            )
            first_cur = await conn.fetchrow(
                "SELECT start_datetime FROM conf_sessions WHERE event_id=$1 AND day=$2 ORDER BY sort_order, start_datetime LIMIT 1",
                event_id, day
            )
            if first_next and first_next["start_datetime"]:
                next_dt = first_next["start_datetime"].astimezone(tz)
                next_time = next_dt.strftime("%H:%M")
                next_date = next_dt.date()
                cur_date = first_cur["start_datetime"].astimezone(tz).date() if first_cur and first_cur["start_datetime"] else None
                diff = (next_date - cur_date).days if cur_date else 999
                when = "завтра" if diff == 1 else f"{next_date.day} {RU_MONTHS[next_date.month - 1]}"
                next_day_mention = f"Встречаемся {when} в {next_time} на День {day + 1}."

        text = build_day_message(text, day, conf_title, day_date_str, day_program,
                                  stream_url, reg_url, raffle_url, day_speakers_gifts, next_day_mention)
        btn_url = btn_url.replace("{stream_url}", stream_url).replace("{registration_url}", reg_url).replace("{raffle_url}", raffle_url)

    elif tpl_type == "speaker_intro":
        if session_id:
            sp = await conn.fetchrow(
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
                session_id
            )
            if sp:
                topics = await conn.fetch(
                    "SELECT topic FROM conf_speaker_topics WHERE cse_id=$1 ORDER BY sort_order LIMIT 1",
                    session_id
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
                reg_url = sp["registration_url"] or ""
                btn_url = btn_url.replace("{registration_url}", reg_url)

    elif tpl_type in ("pre_start", "gift"):
        session_data = {}
        if session_id:
            session = await conn.fetchrow(
                """
                SELECT cs.title as session_title, cs.start_datetime, cs.end_datetime, cs.day,
                       c.name as speaker_name, c.poster_url as speaker_poster,
                       c.personal_tg_username as speaker_personal_tg,
                       cst.topic as speaker_topic,
                       cse.gift_after_speech_title as gift_title,
                       cse.gift_after_speech_url as gift_url,
                       cd.stream_url
                FROM conf_sessions cs
                LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                LEFT JOIN collaborators c ON c.id = cse.speaker_id
                LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
                LEFT JOIN conf_days cd ON cd.event_id = cs.event_id AND cd.day_number = cs.day
                WHERE cs.id=$1
                """,
                session_id
            )
            if session:
                session_data = dict(session)
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
        else:  # pre_start
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
            SELECT e.title as conf_title, cc.description as conf_description,
                   cc.registration_url, cc.poster_horizontal,
                   cd.day_date
            FROM events e
            JOIN conf_conferences cc ON cc.event_id = e.id
            LEFT JOIN conf_days cd ON cd.event_id = e.id AND cd.day_number = 1
            WHERE e.id = $1
            """,
            event_id
        )
        conf_title = (conf_row["conf_title"] or "") if conf_row else ""
        conf_desc = (conf_row["conf_description"] or "") if conf_row else ""
        reg_url = (conf_row["registration_url"] or "") if conf_row else ""
        raw_date = conf_row["day_date"] if conf_row else None
        conf_date_str = f"{raw_date.day} {RU_MONTHS[raw_date.month - 1]}" if raw_date else ""
        poster_h = conf_row["poster_horizontal"] if conf_row else None
        if not photo and poster_h:
            photo = poster_h[0] if isinstance(poster_h, list) else poster_h
        text = text.replace("{conf_title}", conf_title)
        text = text.replace("{conf_description}", conf_desc)
        text = text.replace("{conf_date}", conf_date_str)
        text = text.replace("{registration_url}", reg_url)
        btn_url = btn_url.replace("{registration_url}", reg_url)

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
            "SELECT day_number, day_date, stream_url FROM conf_days WHERE event_id=$1 ORDER BY day_number",
            event_id
        )
        days_by_num = {d["day_number"]: d for d in conf_days_rows}
        first_day = conf_days_rows[0] if conf_days_rows else None
        last_day = conf_days_rows[-1] if conf_days_rows else None

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
            SELECT e.title as conf_title, cc.description as conf_description,
                   cc.registration_url, cc.raffle_url, cc.poster_horizontal
            FROM events e
            JOIN conf_conferences cc ON cc.event_id = e.id
            WHERE e.id=$1
            """,
            event_id
        )
        conf_title = (conf_row["conf_title"] or "") if conf_row else ""
        conf_desc = (conf_row["conf_description"] or "") if conf_row else ""
        reg_url = (conf_row["registration_url"] or "") if conf_row else ""
        raffle_url = (conf_row["raffle_url"] or "") if conf_row else ""
        poster_h = conf_row["poster_horizontal"] if conf_row else None

        raw_first_date = first_day["day_date"] if first_day else None
        conf_date_str = f"{raw_first_date.day} {RU_MONTHS[raw_first_date.month - 1]}" if raw_first_date else ""

        day_number = target_day_num or (first_day["day_number"] if first_day else 1)
        raw_day_date = target_day["day_date"] if target_day else raw_first_date
        day_date_str = f"{raw_day_date.day} {RU_MONTHS[raw_day_date.month - 1]}" if raw_day_date else ""
        stream_url = (target_day["stream_url"] or "") if target_day else ""

        # Программа дня — только если есть привязка к конкретному дню
        day_program = ""
        if target_day_num:
            day_sessions = await conn.fetch(
                """
                SELECT cs.start_datetime, cs.end_datetime, cs.title as session_title,
                       c.name as speaker_name, cse.role
                FROM conf_sessions cs
                LEFT JOIN conf_speaker_events cse ON cse.id = cs.speaker_id
                LEFT JOIN collaborators c ON c.id = cse.speaker_id
                WHERE cs.event_id=$1 AND cs.day=$2
                ORDER BY cs.sort_order, cs.start_datetime
                """,
                event_id, target_day_num
            )
            program_lines = []
            for s in day_sessions:
                t_start = s["start_datetime"].astimezone(tz).strftime("%H:%M") if s["start_datetime"] else ""
                t_end = s["end_datetime"].astimezone(tz).strftime("%H:%M") if s["end_datetime"] else ""
                time_part = f"{t_start}–{t_end}" if t_start and t_end else t_start
                bold_time = f"<b>{time_part}</b>" if time_part else ""
                topic = s["session_title"] or ""
                name = s["speaker_name"] or ""
                role_label = ROLE_LABELS_DAY.get(s["role"] or "", "")
                speaker_part = f" (<b>{name}{' — ' + role_label if role_label else ''}</b>)" if name else ""
                program_lines.append(f"{bold_time}: {topic}{speaker_part}".strip(": "))
            day_program = "\n".join(program_lines)

        if not photo and poster_h:
            photo = poster_h[0] if isinstance(poster_h, list) else poster_h

        ordinal = ORDINALS.get(day_number, f"{day_number}-м")
        text = text.replace("{conf_title}", conf_title)
        text = text.replace("{conf_description}", conf_desc)
        text = text.replace("{conf_date}", conf_date_str)
        text = text.replace("{day_number}", str(day_number))
        text = text.replace("{day_ordinal}", ordinal)
        text = text.replace("{day_date}", day_date_str)
        text = text.replace("{day_program}", day_program)
        text = text.replace("{stream_url}", stream_url)
        text = text.replace("{registration_url}", reg_url)
        text = text.replace("{raffle_url}", raffle_url)

        # Убираем незамененные строки с плейсхолдерами, если значение пустое
        if not day_program:
            text = re.sub(r"^.*\{day_program\}.*$\n?", "", text, flags=re.MULTILINE)
        if not stream_url:
            text = re.sub(r"^.*\{stream_url\}.*$\n?", "", text, flags=re.MULTILINE)

        btn_url = (btn_url
                   .replace("{stream_url}", stream_url)
                   .replace("{registration_url}", reg_url)
                   .replace("{raffle_url}", raffle_url))

    else:
        text = tmpl_text or ""

    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    return {
        "text": text,
        "photo": photo,
        "button_text": btn_text,
        "button_url": btn_url or None,
    }


# ─── Отправка в Telegram ─────────────────────────────────────────────────────

async def send_telegram_message(
    client: httpx.AsyncClient,
    bot_token: str,
    chat_id: str,
    text: str,
    photo_url: str = None,
    button_text: str = None,
    button_url: str = None,
    buttons: list = None,
) -> tuple[bool, str]:
    """Отправляет сообщение через Telegram Bot API.
    - Если передан `buttons` (список {text, url}) — используется он (по одной в ряду, до 3).
    - Иначе, если есть `button_text`+`button_url` — одиночная inline-кнопка (совместимость).
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
        err = resp.json().get("description", f"HTTP {resp.status_code}")
        logger.warning(f"Telegram отклонил сообщение в {chat_id}: {err}")
        return False, err
    except Exception as e:
        logger.warning(f"Ошибка отправки в {chat_id}: {e}")
        return False, str(e)
