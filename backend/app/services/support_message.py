"""
Единое сообщение службы поддержки клиента.

Используется ВЕЗДЕ, где раньше подставлялся одиночный work_tg_username:
команда /support во всех ботах (TG/VK/MAX), кнопка «Тех. поддержка» в меню
события и на странице регистрации, ответы ботов на свободный текст.

Поля клиента (clients):
  work_tg_username — Telegram. Вводится ССЫЛКОЙ (https://t.me/...), но старые
                     значения-ники (@name / name) тоже поддерживаются.
  work_vk          — ВКонтакте (ссылка).
  work_max         — MAX (ссылка).

Формат сообщения (только заполненные строки, между ними пустая строка):

  Возникли вопросы? Напишите нам в любой удобный вам мессенджер:

  ВКонтакте: <ссылка>

  Телеграм: <ссылка>

  MAX: <ссылка>
"""
import html as _html
import re

SUPPORT_INTRO = "Возникли вопросы? Напишите нам в любой удобный вам мессенджер:"


def _norm_tg(raw):
    """work_tg_username → ссылка https://t.me/... Принимает уже-ссылку, @ник, ник."""
    s = (raw or "").strip()
    if not s:
        return ""
    if s.startswith("http://") or s.startswith("https://"):
        return s
    if "t.me/" in s:
        return "https://" + s[s.index("t.me/"):]
    handle = s.lstrip("@").strip()
    return f"https://t.me/{handle}" if handle else ""


def _norm_url(raw):
    """ВК/MAX — берём как ссылку. Голый домен без схемы → добавляем https://."""
    s = (raw or "").strip()
    if not s:
        return ""
    if s.startswith("http://") or s.startswith("https://"):
        return s
    # vk.com/... / max.ru/... без схемы
    if re.match(r"^[\w.-]+\.\w", s):
        return "https://" + s
    return s


def _lines(work_tg, work_vk, work_max) -> list[tuple[str, str]]:
    """[(label, url), ...] только для заполненных каналов. Порядок: ВК, ТГ, MAX."""
    out: list[tuple[str, str]] = []
    vk = _norm_url(work_vk)
    if vk:
        out.append(("ВКонтакте", vk))
    tg = _norm_tg(work_tg)
    if tg:
        out.append(("Телеграм", tg))
    mx = _norm_url(work_max)
    if mx:
        out.append(("MAX", mx))
    return out


def has_support(work_tg=None, work_vk=None, work_max=None) -> bool:
    return bool(_lines(work_tg, work_vk, work_max))


def build_support_message_plain(work_tg=None, work_vk=None, work_max=None) -> str:
    """Plain-текст (VK / MAX — там разметка не нужна, ссылки кликабельны как есть).
    Пустая строка → возвращаем дефолт без каналов."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return "Возникли вопросы? Напишите организатору события."
    body = "\n\n".join(f"{label}: {url}" for label, url in rows)
    return f"{SUPPORT_INTRO}\n\n{body}"


def build_support_message_html(work_tg=None, work_vk=None, work_max=None) -> str:
    """HTML-вариант (Telegram parse_mode=HTML / страница события).
    Ссылка оборачивается в <a href>."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return "Возникли вопросы? Напишите организатору события."
    body = "\n\n".join(
        f'{_html.escape(label)}: <a href="{_html.escape(url)}">{_html.escape(url)}</a>'
        for label, url in rows
    )
    return f"{_html.escape(SUPPORT_INTRO)}\n\n{body}"


def build_support_inline_html(work_tg=None, work_vk=None, work_max=None) -> str:
    """Блок контактов поддержки для подстановки в плейсхолдер {support_link}
    воронок (Telegram HTML). Начинается с переноса строки, далее каждый канал
    с новой строки: <b>Название</b>: ссылка (название площадки жирным).
    Если каналов нет — нейтральный fallback «в этом боте»."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return "в этом боте"
    return "\n" + "\n".join(
        f'<b>{_html.escape(label)}</b>: <a href="{_html.escape(url)}">{_html.escape(url)}</a>'
        for label, url in rows
    )
