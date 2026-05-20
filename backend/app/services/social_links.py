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


_VK_RE_SCREEN = re.compile(r"^[A-Za-z0-9_\.]{2,32}$")
_VK_RE_PUBLIC = re.compile(r"^(?:public|club|id)(\d+)$", re.I)


def normalize_vk_link(s: Optional[str]) -> str:
    """Любой ввод → корректный https-URL VK-сообщества, либо исходная строка.

    Поддерживает:
    - `https://vk.com/foo`, `https://vk.ru/foo`, `vk.com/foo`, `vk.ru/foo`,
      `m.vk.com/foo` — приводит к `https://vk.com/foo`
    - `https://vk.com/public12345`, `club12345` — оставляет как есть
    - `@public12345` или `@username` → `https://vk.com/username`
    - `username` (просто screen_name) → `https://vk.com/username`
    Если строка не похожа на VK — возвращает как есть.
    """
    if not s:
        return ""
    raw = s.strip()
    if not raw:
        return ""
    m = re.match(r"^https?://(?:m\.)?(?:vk\.com|vk\.ru)/(.+)$", raw, re.I)
    if m:
        return f"https://vk.com/{m.group(1).strip('/')}"
    if raw.startswith("vk.com/") or raw.startswith("vk.ru/") or raw.startswith("m.vk.com/"):
        path = raw.split("/", 1)[1].strip("/")
        return f"https://vk.com/{path}" if path else raw
    if raw.startswith("@"):
        u = raw[1:]
        if _VK_RE_PUBLIC.match(u) or _VK_RE_SCREEN.match(u):
            return f"https://vk.com/{u}"
        return raw
    if _VK_RE_PUBLIC.match(raw) or _VK_RE_SCREEN.match(raw):
        return f"https://vk.com/{raw}"
    return raw


def vk_screen_name_from_link(s: Optional[str]) -> str:
    """Из VK-ссылки выделяет screen_name (например `ivision_pluson` или `public212804884`).

    Используется для resolveScreenName при первом сохранении — получить group_id.
    Если строка не VK или пустая — возвращает "".
    """
    norm = normalize_vk_link(s)
    if not norm.startswith("https://vk.com/"):
        return ""
    path = norm[len("https://vk.com/"):].strip("/")
    if not path:
        return ""
    if "/" in path:
        path = path.split("/", 1)[0]
    return path


def normalize_social_links(social: Optional[dict]) -> dict:
    """Нормализует все известные платформенные поля внутри social_links."""
    if not isinstance(social, dict):
        return {}
    out = dict(social)
    if out.get("telegram"):
        out["telegram"] = normalize_telegram_link(out["telegram"])
    if out.get("vk"):
        out["vk"] = normalize_vk_link(out["vk"])
    return out
