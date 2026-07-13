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


def support_url_for_platform(platform: str, work_tg=None, work_vk=None, work_max=None) -> str:
    """Ссылка на поддержку ТОЙ площадки, куда уходит сообщение.

    Рассылка собирается один раз на все платформы, но контакт поддержки должен
    быть «свой»: в Telegram — телеграм-поддержка, в VK — VK, в MAX — MAX.
    Подставляется на этапе отправки в каждой платформенной ветке (как {first_name}).
    Нет контакта на этой площадке — пусто (плейсхолдер просто исчезает)."""
    p = (platform or "").lower()
    if p == "telegram":
        return _norm_tg(work_tg)
    if p == "vk":
        return _norm_url(work_vk)
    if p == "max":
        return _norm_url(work_max)
    if p == "email":
        # В письме кликабельны любые ссылки — отдаём первый заполненный канал.
        rows = _lines(work_tg, work_vk, work_max)
        return rows[0][1] if rows else ""
    return ""


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


_REPLY_INTRO = "Спасибо, видим ваше сообщение и скоро вам ответим 💛"
_REPLY_BRIDGE = "Так же вы можете связаться с тех поддержкой напрямую — напишите по этим контактам:"


def build_user_reply_plain(work_tg=None, work_vk=None, work_max=None) -> str:
    """Авто-ответ бота на свободное сообщение пользователя (VK / MAX, plain).
    Приветствие + готовые контакты поддержки по всем заполненным площадкам.
    Если контактов нет — только приветствие."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return _REPLY_INTRO
    body = "\n".join(f"{label}: {url}" for label, url in rows)
    return f"{_REPLY_INTRO}\n\n{_REPLY_BRIDGE}\n\n{body}"


def build_user_reply_html(work_tg=None, work_vk=None, work_max=None) -> str:
    """Авто-ответ бота на свободное сообщение пользователя (Telegram HTML)."""
    rows = _lines(work_tg, work_vk, work_max)
    if not rows:
        return _REPLY_INTRO
    body = "\n".join(
        f'{_html.escape(label)}: <a href="{_html.escape(url)}">{_html.escape(url)}</a>'
        for label, url in rows
    )
    return f"{_REPLY_INTRO}\n\n{_html.escape(_REPLY_BRIDGE)}\n\n{body}"


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
