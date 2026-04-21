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

logger = logging.getLogger(__name__)

ROLE_LABELS_INTRO = {
    "speaker": "Спикер",
    "headliner": "Хедлайнер",
    "partner": "Партнёр",
    "organizer": "Организатор",
}

ORDINALS = {1: "первом", 2: "втором", 3: "третьем", 4: "четвёртом", 5: "пятом"}


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

    # Убираем строки с пустыми плейсхолдерами ДО подстановки
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
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ─── Отправка в Telegram ─────────────────────────────────────────────────────

async def send_telegram_message(
    client: httpx.AsyncClient,
    bot_token: str,
    chat_id: str,
    text: str,
    photo_url: str = None,
    button_text: str = None,
    button_url: str = None,
) -> tuple[bool, str]:
    """Отправляет сообщение через Telegram Bot API. Возвращает (успех, описание_ошибки)."""
    try:
        reply_markup = None
        if button_text and button_url:
            reply_markup = {"inline_keyboard": [[{"text": button_text, "url": button_url}]]}

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
