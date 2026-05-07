"""Нормализация ссылок на соцсети к каноничному https-формату.

Используется в двух местах:
- `client_profile.PATCH /me/profile` — приводит ввод клиента к https-URL перед записью
- `funnel_service._get_brand_context` — приводит сохранённое значение перед подстановкой
  в шаблон воронки (`{subscription_channel}`).

Главная цель — корректно работать с инвайт-ссылками закрытых каналов
(`https://t.me/+abc...`), для которых @-префикс не годится.
"""
import re
from typing import Optional

_TG_RE_INVITE = re.compile(r"^\+[A-Za-z0-9_-]+$")
_TG_RE_USERNAME = re.compile(r"^[A-Za-z0-9_]{4,32}$")


def normalize_telegram_link(s: Optional[str]) -> str:
    """Любой ввод → корректный https-URL Telegram, либо исходная строка.

    Поддерживает:
    - `https://t.me/foo`, `http://t.me/foo`, `t.me/foo`, `telegram.me/foo`
    - `https://t.me/+abc` (закрытый канал — инвайт)
    - `@username`              → `https://t.me/username`
    - `+abc` (без хоста)       → `https://t.me/+abc`
    - `username` (без префикса) → `https://t.me/username`
    Если строка не похожа ни на один из форматов — возвращаем её как есть
    (не добавляя @, не теряя данные).
    """
    if not s:
        return ""
    raw = s.strip()
    if not raw:
        return ""
    m = re.match(r"^https?://(?:t\.me|telegram\.me)/(.+)$", raw, re.I)
    if m:
        return f"https://t.me/{m.group(1).strip('/')}"
    if raw.startswith("t.me/") or raw.startswith("telegram.me/"):
        path = raw.split("/", 1)[1].strip("/")
        return f"https://t.me/{path}" if path else raw
    if raw.startswith("@"):
        u = raw[1:]
        # `@+abcDEF...` — артефакт старого кода (он лепил @ ко всему, включая
        # инвайт-коды закрытых каналов). Чиним и такие записи.
        if u.startswith("+") and _TG_RE_INVITE.match(u):
            return f"https://t.me/{u}"
        if _TG_RE_USERNAME.match(u):
            return f"https://t.me/{u}"
        return raw
    if _TG_RE_INVITE.match(raw):
        return f"https://t.me/{raw}"
    if _TG_RE_USERNAME.match(raw):
        return f"https://t.me/{raw}"
    return raw


def telegram_api_id(s: Optional[str]) -> str:
    """Возвращает идентификатор канала для Telegram Bot API (`getChatMember`).

    Bot API принимает `@channelname` или числовой chat_id. Из любого ввода
    выделяем username (если он есть) и отдаём с префиксом `@`. Для инвайт-ссылок
    закрытых каналов (`+abc`) возвращаем пустую строку — getChatMember
    с инвайт-кодом не работает, проверить подписку этим способом нельзя.
    """
    norm = normalize_telegram_link(s)
    if not norm.startswith("https://t.me/"):
        return ""
    path = norm[len("https://t.me/"):].strip("/")
    if not path or path.startswith("+"):
        return ""
    if "/" in path:  # вида `https://t.me/foo/123` — берём только канал
        path = path.split("/", 1)[0]
    return f"@{path}"


def normalize_social_links(social: Optional[dict]) -> dict:
    """Нормализует все известные TG-поля внутри social_links."""
    if not isinstance(social, dict):
        return {}
    out = dict(social)
    if out.get("telegram"):
        out["telegram"] = normalize_telegram_link(out["telegram"])
    return out
