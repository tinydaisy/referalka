"""
ЕДИНСТВЕННОЕ МЕСТО ДЛЯ ФОРМИРОВАНИЯ ТЕКСТА И ОТПРАВКИ СООБЩЕНИЙ РАССЫЛОК.

Все функции формирования текста шаблонов и отправки в Telegram живут ЗДЕСЬ.
Импортируются везде:
  - app/tasks/broadcast.py  (Celery)
  - app/api/modules/broadcasts.py  (FastAPI — превью и тест-отправка)

НИКОГДА не писать аналогичный код в другом месте.
"""
import re
import json as _json
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


# ─── Ссылка на карточку спикера + соцсети (общие хелперы) ────────────────────

def speaker_card_link(event_slug, ec_id, link_mode=None, bot_handle=None):
    """Ссылка на карточку конкретного спикера/жюри.
    link_mode='miniapp' + есть бот клиента → Mini App (t.me/{bot}?startapp=ref_pg{slug}_spk{ec}).
    Иначе → веб-страница события pluson.ru/event/{slug}?spk={ec}."""
    slug = (event_slug or "").strip()
    if not slug or not ec_id:
        return ""
    if link_mode == "miniapp" and bot_handle:
        h = str(bot_handle).lstrip("@")
        return f"https://t.me/{h}?startapp=ref_pg{slug}_spk{ec_id}"
    return f"https://pluson.ru/event/{slug}?spk={ec_id}"


def build_speaker_socials(tg_channel_url=None, vk_url=None, max_url=None,
                          instagram_url=None, website_url=None, personal_tg=None):
    """Все соцсети спикера единым блоком (по строке на непустую). Для {speaker_socials}
    и как расширение {speaker_personal_tg} (раньше был только личный TG)."""
    lines = []
    p = (personal_tg or "").strip().lstrip("@")
    if p:
        lines.append(f"Telegram: @{p}")
    if (tg_channel_url or "").strip():
        lines.append(f"Тг канал: {tg_channel_url.strip()}")
    if (vk_url or "").strip():
        lines.append(f"VK: {vk_url.strip()}")
    if (max_url or "").strip():
        lines.append(f"MAX: {max_url.strip()}")
    if (instagram_url or "").strip():
        lines.append(f"Instagram: {instagram_url.strip()}")
    if (website_url or "").strip():
        lines.append(f"Сайт: {website_url.strip()}")
    return "\n".join(lines)


# ─── Формирование текста: speaker_intro ─────────────────────────────────────

def build_speaker_intro_message(tmpl_text, speaker_name, personal_tg, tg_channel_url, instagram_url,
                                achievements, role, speaker_topic, gift_title, gift_raffle, registration_url,
                                bio=None, positioning=None, card_link=None,
                                vk_url=None, max_url=None, website_url=None,
                                speaker_notes=None):
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
    # Все соцсети спикера (для {speaker_socials} и расширенного {speaker_personal_tg}).
    socials_block = build_speaker_socials(tg_channel_url, vk_url, max_url,
                                          instagram_url, website_url, personal_tg)
    bio_v = (bio or "").strip()
    positioning_v = (positioning or "").strip()
    card_link_v = (card_link or "").strip()
    notes_v = (speaker_notes or "").strip()

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
    # {speaker_personal_tg} теперь = ВСЕ соцсети спикера (не только личный TG).
    if not socials_block:
        text = re.sub(r"^[^\n]*\{speaker_personal_tg\}[^\n]*\n?", "", text, flags=re.MULTILINE)
        text = re.sub(r"^[^\n]*\{speaker_socials\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not bio_v:
        text = re.sub(r"^[^\n]*\{speaker_bio\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not positioning_v:
        text = re.sub(r"^[^\n]*\{speaker_positioning\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not card_link_v:
        text = re.sub(r"^[^\n]*\{speaker_card_link\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    if not notes_v:
        text = re.sub(r"^[^\n]*\{speaker_notes\}[^\n]*\n?", "", text, flags=re.MULTILINE)

    text = text.replace("{speaker_personal_tg}", socials_block)
    text = text.replace("{speaker_socials}", socials_block)
    text = text.replace("{speaker_bio}", bio_v)
    text = text.replace("{speaker_positioning}", positioning_v)
    text = text.replace("{speaker_card_link}", card_link_v)
    text = text.replace("{speaker_notes}", notes_v)
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

def build_speaker_material(kb_title, kb_url):
    """Материал спикера в базу знаний ({speaker_material}): «Название\\nссылка».
    Пусто → пустая строка (плейсхолдер потом убирается вместе со своей строкой)."""
    t = (kb_title or "").strip()
    u = (kb_url or "").strip()
    if not t and not u:
        return ""
    if t and u:
        return f"{t}\n{u}"
    return t or u


def apply_speaker_material(text, material):
    """Подставить {speaker_material} в текст. Если материала нет — удалить строку
    с плейсхолдером целиком (как gift_url/personal_tg)."""
    if "{speaker_material}" not in (text or ""):
        return text
    if not material:
        return re.sub(r"^[^\n]*\{speaker_material\}[^\n]*\n?", "", text, flags=re.MULTILINE).strip()
    return text.replace("{speaker_material}", material)


def build_gift_message(speaker_name, personal_tg, gift_title, gift_url, tmpl_text=None, gifts=None):
    """Формирует сообщение-подарок.
    Если задан tmpl_text — используется он с подстановкой плейсхолдеров
    ({speaker_name}, {gift_title}, {gift_url}, {personal_tg}).
    Иначе — встроенный формат по умолчанию.

    gifts — СПИСОК подарков-лид-магнитов спикера (до 4): [{"title","url"}, ...].
    Если передан и непуст, {gift_title}/{gift_url} (или дефолтное тело) заменяются
    на многострочный блок «Название\\nссылка» по всем подаркам. Одиночные
    gift_title/gift_url — fallback (ручной подарок / обратная совместимость).
    """
    tg_raw = (personal_tg or "").strip()
    tg_mention = ("@" + tg_raw.lstrip("@")) if tg_raw else ""

    # Нормализуем список подарков (непустые названия)
    glist = []
    for g in (gifts or []):
        t = ((g or {}).get("title") or "").strip()
        u = ((g or {}).get("url") or "").strip()
        if t:
            glist.append((t, u))
    # Если списка нет — используем одиночный подарок как единственный элемент.
    if not glist:
        t0 = (gift_title or "").strip()
        u0 = (gift_url or "").strip()
        if t0:
            glist = [(t0, u0)]

    def _gifts_block():
        # «Название\nссылка» по каждому подарку, разделитель — пустая строка
        parts = []
        for t, u in glist:
            parts.append(f"{t}\n{u}" if u else t)
        return "\n\n".join(parts)

    title = glist[0][0] if glist else ""
    url = glist[0][1] if glist else ""

    tmpl = (tmpl_text or "").strip()
    if tmpl and any(p in tmpl for p in ("{speaker_name}", "{gift_title}", "{gift_url}", "{personal_tg}")):
        text = tmpl
        multi = len(glist) > 1
        # Многоподарочный случай: строку с {gift_title} превращаем в блок всех подарков,
        # строку с {gift_url} убираем (ссылки уже внутри блока).
        if multi and "{gift_title}" in text:
            text = re.sub(r"^[^\n]*\{gift_url\}[^\n]*\n?", "", text, flags=re.MULTILINE)
            title = _gifts_block()
            url = ""
        else:
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
    if not glist:
        body = f"🎁 Чтобы забрать материалы — пишите в личку {tg_mention}" if tg_mention else "🎁 Чтобы забрать материалы — напишите спикеру в личку"
    else:
        body = _gifts_block()
    return f"{header}\n\n{body}"


# ─── Формирование текста: pre_start (анонс спикера) ─────────────────────────

def build_pre_start_message(tmpl_text, speaker_name, speaker_topic, stream_url_val,
                            personal_tg=None, tg_channel_url=None, instagram_url=None,
                            vk_url=None, max_url=None, website_url=None,
                            achievements=None, role=None, bio=None, positioning=None,
                            card_link=None, speaker_notes=None):
    text = tmpl_text or ""
    text = text.replace("{stream_url}", stream_url_val or "")
    # Полный набор спикер-плейсхолдеров (те же, что в speaker_intro), чтобы
    # «за 5 минут до выступления» тоже мог показывать соцсети/био/ссылку и т.п.
    socials_block = build_speaker_socials(tg_channel_url, vk_url, max_url,
                                          instagram_url, website_url, personal_tg)
    ach_list = [a.strip() for a in (achievements or []) if a.strip()]
    ach_text = "\n".join(f"• {a}" for a in ach_list)
    role_label = ROLE_LABELS_INTRO.get(role or "", "Спикер")
    tg_ch = (tg_channel_url or "").strip()
    insta = (instagram_url or "").strip()
    text = text.replace("{speaker_name}", speaker_name or "")
    text = text.replace("{speaker_topic}", speaker_topic or "")
    text = text.replace("{speaker_role}", role_label)
    text = text.replace("{speaker_achievements}", ach_text)
    text = text.replace("{speaker_personal_tg}", socials_block)
    text = text.replace("{speaker_socials}", socials_block)
    text = text.replace("{speaker_bio}", (bio or "").strip())
    text = text.replace("{speaker_positioning}", (positioning or "").strip())
    text = text.replace("{speaker_card_link}", (card_link or "").strip())
    notes_v = (speaker_notes or "").strip()
    if not notes_v:
        text = re.sub(r"^[^\n]*\{speaker_notes\}[^\n]*\n?", "", text, flags=re.MULTILINE)
    text = text.replace("{speaker_notes}", notes_v)
    text = text.replace("{speaker_tg}", f"<b>Тг канал:</b> {tg_ch}" if tg_ch else "")
    text = text.replace("{speaker_instagram}", f"<b>Нельзяграм:</b> {insta}" if insta else "")
    return text.strip()


# ─── Формирование текста: дневные шаблоны ───────────────────────────────────

def build_day_message(tmpl_text, day_number, conf_title, day_date, day_program,
                      stream_url_val, registration_url_val, raffle_url_val="", day_speakers_gifts="",
                      next_day_mention="", day_title="", day_datetime="", day_program_with_links=""):
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
    # ВАЖНО: {day_program_with_links} заменяем ДО {day_program} — иначе
    # .replace("{day_program}") затронет подстроку внутри _with_links.
    text = text.replace("{day_program_with_links}", day_program_with_links or day_program or "")
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
                   e.slug AS event_slug,
                   cc.raffle_url,
                   e.stream_url,
                   cd.title AS day_title,
                   COALESCE(cd.day_date,
                            (e.start_at AT TIME ZONE 'Europe/Moscow')::date) AS day_date,
                   (e.start_at AT TIME ZONE 'Europe/Moscow') AS event_start_msk,
                   cl.default_link_mode,
                   (SELECT ch.handle FROM client_channels cc2 JOIN channels ch ON ch.id=cc2.channel_id
                      WHERE cc2.client_id=cl.id AND cc2.is_active AND ch.platform_slug='telegram'
                        AND ch.is_system=FALSE AND ch.handle IS NOT NULL LIMIT 1) AS bot_handle
            FROM events e
            LEFT JOIN conf_conferences cc ON cc.event_id = e.id
            LEFT JOIN clients cl ON cl.id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
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
                   COALESCE(cst.topic, (SELECT t.topic FROM conf_speaker_topics t WHERE t.cse_id = cs.speaker_id ORDER BY t.sort_order, t.id LIMIT 1), cs.title) as session_title,
                   c.name as speaker_name, cse.role, cse.id AS ec_id
            FROM conf_sessions cs
            LEFT JOIN event_collaborators cse ON cse.id = cs.speaker_id
            LEFT JOIN collaborators c ON c.id = cse.speaker_id
            LEFT JOIN conf_speaker_topics cst ON cst.id = cs.topic_id
            WHERE cs.event_id=$1 AND cs.day=$2
            ORDER BY cs.sort_order, cs.start_time
            """,
            event_id, day
        ) if is_program_event else []
        _prog_slug = conf_row["event_slug"] if conf_row else None
        _prog_link_mode = conf_row["default_link_mode"] if conf_row else None
        _prog_bot = conf_row["bot_handle"] if conf_row else None
        program_lines = []
        program_lines_links = []   # для {day_program_with_links} — имя спикера ссылкой
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
            # Версия со ссылкой: имя спикера — <a href=карточка>Имя</a>
            if name:
                _link = speaker_card_link(_prog_slug, s["ec_id"], _prog_link_mode, _prog_bot)
                name_html = f'<a href="{_link}">{name}</a>' if _link else name
                speaker_part_l = f" (<b>{name_html}{' — ' + role_label if role_label else ''}</b>)"
            else:
                speaker_part_l = ""
            program_lines_links.append(f"{bold_time}: {topic}{speaker_part_l}".strip(": "))
        day_program = "\n".join(program_lines)
        day_program_with_links = "\n".join(program_lines_links)

        day_speakers_gifts = ""
        next_day_mention = ""
        if tpl_type == "day_end":
            gift_sessions = await conn.fetch(
                """
                SELECT c.name as speaker_name,
                       pu_tg.username AS personal_tg_username,
                       cse.gift_after_speech_title, cse.gift_after_speech_url, cse.role, cse.is_commercial,
                       (SELECT json_agg(g ORDER BY g.sort_order, g.id) FROM (
                          SELECT eclm.id, eclm.sort_order,
                                 COALESCE(glm.name, glp.name) AS title,
                                 CASE WHEN eclm.package_id IS NOT NULL AND glp.slug IS NOT NULL
                                      THEN 'https://pluson.ru/p/'||glp.slug
                                      ELSE glm.url END AS url
                            FROM event_collaborator_lead_magnets eclm
                            LEFT JOIN lead_magnets glm ON glm.id = eclm.lead_magnet_id
                            LEFT JOIN lead_magnet_packages glp ON glp.id = eclm.package_id
                           WHERE eclm.ec_id = cse.id
                       ) g) AS gift_magnets_json
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
                # Список подарков-лид-магнитов спикера (до 4). Приоритет ручному подарку.
                _gm = gs["gift_magnets_json"]
                if isinstance(_gm, str):
                    try:
                        _gm = _json.loads(_gm)
                    except (ValueError, TypeError):
                        _gm = None
                magnets = [(g.get("title"), g.get("url")) for g in (_gm or []) if g and g.get("title")]
                if not title and magnets:
                    body = "\n\n".join(f"{t}\n{u}" if u else t for t, u in magnets)
                    block = f"🎁 <b>{gs['speaker_name']}:</b>\n{body}"
                elif not title:
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
                                  day_title=day_title, day_datetime=day_datetime_str,
                                  day_program_with_links=day_program_with_links)
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
                       c.vk_url, c.max_url, c.website_url,
                       c.title AS positioning, c.hub_about AS bio,
                       c.achievements,
                       cse.id AS ec_id, cse.role, cse.gift_after_speech_title, cse.gift_after_speech_url,
                       cse.gift_raffle_title, cse.notes AS speaker_notes,
                       cse.knowledge_base_title, cse.knowledge_base_url,
                       e.slug AS event_slug,
                       e.landing_url AS registration_url,
                       cl.default_link_mode,
                       (SELECT ch.handle FROM client_channels cc JOIN channels ch ON ch.id=cc.channel_id
                          WHERE cc.client_id=cl.id AND cc.is_active AND ch.platform_slug='telegram'
                            AND ch.is_system=FALSE AND ch.handle IS NOT NULL LIMIT 1) AS bot_handle
                FROM event_collaborators cse
                JOIN collaborators c ON c.id = cse.speaker_id
                JOIN events e ON e.id = cse.event_id
                JOIN clients cl ON cl.id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
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
                card_link = speaker_card_link(sp["event_slug"], sp["ec_id"],
                                              sp["default_link_mode"], sp["bot_handle"])
                text = build_speaker_intro_message(
                    text, sp["speaker_name"], sp["personal_tg_username"],
                    sp["tg_channel_url"], sp["instagram_url"],
                    sp["achievements"], sp["role"],
                    topic, sp["gift_after_speech_title"],
                    sp["gift_raffle_title"], sp["registration_url"],
                    bio=sp["bio"], positioning=sp["positioning"], card_link=card_link,
                    vk_url=sp["vk_url"], max_url=sp["max_url"], website_url=sp["website_url"],
                    speaker_notes=sp["speaker_notes"]
                )
                text = apply_speaker_material(
                    text,
                    build_speaker_material(sp["knowledge_base_title"], sp["knowledge_base_url"]),
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
                       c.tg_channel_url, c.instagram_url, c.vk_url, c.max_url, c.website_url,
                       c.title AS positioning, c.hub_about AS bio, c.achievements,
                       cse.role, cse.id AS ec_id, e.slug AS event_slug,
                       cse.notes AS speaker_notes,
                       cst.topic as speaker_topic,
                       cse.gift_after_speech_title as gift_title,
                       cse.gift_after_speech_url as gift_url,
                       cse.knowledge_base_title, cse.knowledge_base_url,
                       cse.gift_lead_magnet_id, cse.gift_package_id,
                       lm.name AS lm_name, lm.url AS lm_url,
                       lp.name AS lp_name, lp.slug AS lp_slug,
                       (SELECT json_agg(g ORDER BY g.sort_order, g.id) FROM (
                          SELECT eclm.id, eclm.sort_order,
                                 COALESCE(glm.name, glp.name) AS title,
                                 CASE WHEN eclm.package_id IS NOT NULL AND glp.slug IS NOT NULL
                                      THEN 'https://pluson.ru/p/'||glp.slug
                                      ELSE glm.url END AS url
                            FROM event_collaborator_lead_magnets eclm
                            LEFT JOIN lead_magnets glm ON glm.id = eclm.lead_magnet_id
                            LEFT JOIN lead_magnet_packages glp ON glp.id = eclm.package_id
                           WHERE eclm.ec_id = cse.id
                       ) g) AS gift_magnets_json,
                       e.stream_url,
                       cl.default_link_mode,
                       (SELECT ch.handle FROM client_channels cc JOIN channels ch ON ch.id=cc.channel_id
                          WHERE cc.client_id=cl.id AND cc.is_active AND ch.platform_slug='telegram'
                            AND ch.is_system=FALSE AND ch.handle IS NOT NULL LIMIT 1) AS bot_handle
                FROM conf_sessions cs
                LEFT JOIN events e ON e.id = cs.event_id
                LEFT JOIN clients cl ON cl.id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
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
                # Список подарков-лид-магнитов спикера (до 4, миграция 200).
                _gm = session_data.get("gift_magnets_json")
                if isinstance(_gm, str):
                    try:
                        _gm = _json.loads(_gm)
                    except (ValueError, TypeError):
                        _gm = None
                session_data["gift_magnets_list"] = [
                    {"title": g.get("title"), "url": g.get("url")}
                    for g in (_gm or []) if g and g.get("title")
                ]
                # Одиночный подарок (fallback): приоритет ручному вводу; иначе из ПЛЮСОНа.
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
        speaker_material = build_speaker_material(
            session_data.get("knowledge_base_title"), session_data.get("knowledge_base_url"))
        if tpl_type == "gift":
            text = build_gift_message(
                session_data.get("speaker_name"),
                session_data.get("speaker_personal_tg"),
                session_data.get("gift_title"),
                session_data.get("gift_url"),
                tmpl_text=tmpl_text,
                gifts=session_data.get("gift_magnets_list"),
            )
            text = apply_speaker_material(text, speaker_material)
        else:  # 5min_before
            card_link = speaker_card_link(session_data.get("event_slug"), session_data.get("ec_id"),
                                          session_data.get("default_link_mode"), session_data.get("bot_handle"))
            text = build_pre_start_message(
                text,
                session_data.get("speaker_name"),
                session_data.get("speaker_topic") or session_data.get("session_title"),
                stream_url,
                personal_tg=session_data.get("speaker_personal_tg"),
                tg_channel_url=session_data.get("tg_channel_url"),
                instagram_url=session_data.get("instagram_url"),
                vk_url=session_data.get("vk_url"),
                max_url=session_data.get("max_url"),
                website_url=session_data.get("website_url"),
                achievements=session_data.get("achievements"),
                role=session_data.get("role"),
                bio=session_data.get("bio"),
                positioning=session_data.get("positioning"),
                card_link=card_link,
                speaker_notes=session_data.get("speaker_notes"),
            )
            text = apply_speaker_material(text, speaker_material)
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
                   e.landing_url AS registration_url, e.slug AS event_slug, cc.raffle_url,
                   cl.default_link_mode,
                   (SELECT ch.handle FROM client_channels cc2 JOIN channels ch ON ch.id=cc2.channel_id
                      WHERE cc2.client_id=cl.id AND cc2.is_active AND ch.platform_slug='telegram'
                        AND ch.is_system=FALSE AND ch.handle IS NOT NULL LIMIT 1) AS bot_handle
            FROM events e
            JOIN conf_conferences cc ON cc.event_id = e.id
            LEFT JOIN clients cl ON cl.id = (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)
            WHERE e.id=$1
            """,
            event_id
        )
        conf_title = (conf_row["conf_title"] or "") if conf_row else ""
        conf_desc = html_to_telegram((conf_row["conf_description"] or "") if conf_row else "")
        reg_url = (conf_row["registration_url"] or "") if conf_row else ""
        raffle_url = (conf_row["raffle_url"] or "") if conf_row else ""
        _c_slug = conf_row["event_slug"] if conf_row else None
        _c_link_mode = conf_row["default_link_mode"] if conf_row else None
        _c_bot = conf_row["bot_handle"] if conf_row else None

        raw_first_date = first_day["day_date"] if first_day else None
        conf_date_str = f"{raw_first_date.day} {RU_MONTHS[raw_first_date.month - 1]}" if raw_first_date else ""

        day_number = target_day_num or (first_day["day_number"] if first_day else 1)
        raw_day_date = target_day["day_date"] if target_day else raw_first_date
        day_date_str = f"{raw_day_date.day} {RU_MONTHS[raw_day_date.month - 1]}" if raw_day_date else ""
        stream_url = event_stream_url

        # Программа дня — только если есть привязка к конкретному дню
        day_program = ""
        day_program_with_links = ""
        if target_day_num:
            day_sessions = await conn.fetch(
                """
                SELECT cs.start_time, cs.end_time,
                       COALESCE(cst.topic, (SELECT t.topic FROM conf_speaker_topics t WHERE t.cse_id = cs.speaker_id ORDER BY t.sort_order, t.id LIMIT 1), cs.title) as session_title,
                       c.name as speaker_name, cse.role, cse.id AS ec_id
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
            program_lines_links = []
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
                if name:
                    _link = speaker_card_link(_c_slug, s["ec_id"], _c_link_mode, _c_bot)
                    name_html = f'<a href="{_link}">{name}</a>' if _link else name
                    speaker_part_l = f" (<b>{name_html}{' — ' + role_label if role_label else ''}</b>)"
                else:
                    speaker_part_l = ""
                program_lines_links.append(f"{bold_time}: {topic}{speaker_part_l}".strip(": "))
            day_program = "\n".join(program_lines)
            day_program_with_links = "\n".join(program_lines_links)

        if not photo:
            photo = await get_default_event_photo(conn, event_id)

        ordinal = ORDINALS.get(day_number, f"{day_number}-м")
        text = text.replace("{conf_title}", conf_title)
        text = text.replace("{conf_description}", conf_desc)
        text = text.replace("{conf_date}", conf_date_str)
        text = text.replace("{day_number}", str(day_number))
        text = text.replace("{day_ordinal}", ordinal)
        text = text.replace("{day_date}", day_date_str)
        text = text.replace("{day_program_with_links}", day_program_with_links or day_program)
        text = text.replace("{day_program}", day_program)
        text = text.replace("{stream_url}", stream_url)
        text = text.replace("{landing_url}", reg_url)
        text = text.replace("{registration_url}", reg_url)
        text = text.replace("{raffle_url}", raffle_url)

        # Убираем незамененные строки с плейсхолдерами, если значение пустое
        if not day_program:
            text = re.sub(r"^.*\{day_program_with_links\}.*$\n?", "", text, flags=re.MULTILINE)
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

    # Финальная зачистка: любой известный плейсхолдер, не подставленный этим
    # типом шаблона (клиент вставил его вручную в неподходящий тип), НЕ должен
    # уйти получателю сырым. Убираем строку целиком, если плейсхолдер — единственное
    # значимое на ней, иначе просто вырезаем сам плейсхолдер.
    _KNOWN_PLACEHOLDERS = [
        "speaker_name", "speaker_role", "speaker_personal_tg", "speaker_socials",
        "speaker_tg", "speaker_instagram", "speaker_topic", "speaker_achievements",
        "speaker_bio", "speaker_positioning", "speaker_card_link", "speaker_material",
        "gift_after_speech_title", "gift_raffle_title", "gift_title", "gift_url",
        "stream_url", "landing_url", "registration_url", "conf_title", "conf_date",
        "conf_description", "day_number", "day_ordinal", "day_title", "day_date",
        "day_datetime", "day_program", "day_program_with_links", "next_day_mention",
        "raffle_url", "day_speakers_gifts", "vip_url",
        # ⚠️ НЕ включаем {first_name} и {game_link} — они персонализируются
        # per-получатель в broadcast.py уже ПОСЛЕ build_message_content.
    ]
    for ph in _KNOWN_PLACEHOLDERS:
        token = "{" + ph + "}"
        if token in text:
            # строка, где плейсхолдер один (возможно с ярлыком/эмодзи) → удалить строку
            text = re.sub(r"^[^\n]*" + re.escape(token) + r"[^\n]*$\n?", "", text, flags=re.MULTILINE)
            text = text.replace(token, "")

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
# Кеш скачанных байт фото и полученного file_id по URL — фото качается с R2
# максимум один раз на рассылку, дальше остальным шлём по file_id (мгновенно).
_PHOTO_BYTES_CACHE: dict[str, bytes] = {}
_PHOTO_FID_CACHE: dict[str, str] = {}


async def _tg_send_photo(
    client: httpx.AsyncClient,
    bot_token: str,
    chat_id: str,
    photo_url: str,
    caption: str | None = None,
    reply_markup: dict | None = None,
) -> tuple[bool, str]:
    """Надёжно отправляет ФОТО в Telegram (аналогично _tg_send_video).

    Раньше фото слали по R2-URL и НЕ проверяли результат → если Telegram не мог
    скачать картинку по ссылке (частая проблема с R2), фото молча терялось, а
    текст уходил отдельно. Теперь: 1) по file_id (мгновенно, если уже качали);
    2) иначе скачиваем байты с R2 и грузим multipart-ом (Telegram принимает
    байты всегда), проверяем ok, кешируем file_id для остальных получателей.

    caption — подпись под фото (для короткого текста ≤1024); при длинном тексте
    вызывающий шлёт caption=None и досылает текст отдельным сообщением.
    Возвращает (успех, ошибка)."""
    def _fields() -> dict:
        d = {"chat_id": chat_id}
        if caption:
            d["caption"] = caption
            d["parse_mode"] = "HTML"
        if reply_markup:
            import json as _j
            d["reply_markup"] = _j.dumps(reply_markup)
        return d

    # 1) уже есть file_id с прошлого получателя — шлём по нему (JSON, мгновенно)
    fid = _PHOTO_FID_CACHE.get(photo_url)
    if fid:
        payload = {"chat_id": chat_id, "photo": fid}
        if caption:
            payload["caption"] = caption
            payload["parse_mode"] = "HTML"
        if reply_markup:
            payload["reply_markup"] = reply_markup
        try:
            r = await client.post(f"https://api.telegram.org/bot{bot_token}/sendPhoto", json=payload, timeout=60)
            data = r.json()
            if data.get("ok"):
                return True, ""
            # file_id мог быть от другого бота (fanout) — падаем на multipart
        except Exception:
            pass

    # 2) скачиваем байты (кеш на рассылку) и грузим multipart-ом
    content = _PHOTO_BYTES_CACHE.get(photo_url)
    if content is None:
        try:
            rr = await client.get(photo_url, timeout=60)
            if rr.status_code != 200:
                return False, f"R2 GET {rr.status_code}"
            content = rr.content
            _PHOTO_BYTES_CACHE[photo_url] = content
        except Exception as e:
            return False, f"download: {e}"
    ext = ".jpg"
    low = photo_url.lower()
    for e in (".png", ".jpeg", ".jpg", ".webp"):
        if e in low:
            ext = e
            break
    ctype = {".png": "image/png", ".webp": "image/webp"}.get(ext, "image/jpeg")
    try:
        r = await client.post(
            f"https://api.telegram.org/bot{bot_token}/sendPhoto",
            data=_fields(),
            files={"photo": (f"photo{ext}", content, ctype)},
            timeout=120,
        )
        data = r.json()
        if data.get("ok"):
            # достаём file_id самого большого размера для кеша
            photos = (data.get("result", {}) or {}).get("photo") or []
            if photos:
                _PHOTO_FID_CACHE[photo_url] = photos[-1].get("file_id")
            return True, ""
        return False, data.get("description", f"HTTP {r.status_code}")
    except Exception as e:
        return False, str(e)


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
            # Короткий текст — фото с подписью одним сообщением. Надёжная отправка
            # (скачиваем байты → multipart → кеш file_id), с проверкой результата.
            ok, err = await _tg_send_photo(client, bot_token, chat_id, photo_url,
                                           caption=text, reply_markup=reply_markup)
            if ok:
                return True, ""
            return False, err
        elif photo_url:
            # Длинный текст (>1024) — фото ОТДЕЛЬНЫМ сообщением, следом текст.
            # ⚠️ Раньше первый sendPhoto по URL не проверялся → фото молча терялось,
            # уходил только текст. Теперь надёжная отправка фото с проверкой.
            ok_p, err_p = await _tg_send_photo(client, bot_token, chat_id, photo_url,
                                               caption=None, reply_markup=None)
            if not ok_p:
                logger.warning(f"broadcast: фото не ушло ({err_p}) для {chat_id} — шлём только текст")
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
