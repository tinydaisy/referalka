"""Нормализация ссылок на соцсети к каноничному https-формату.

Используется в двух местах:
- `client_profile.PATCH /me/profile` — приводит ввод клиента к https-URL перед записью
- `funnel_service._get_brand_context` — приводит сохранённое значение перед подстановкой
  в шаблон воронки (`{subscription_channel}`).

Главная цель — корректно работать с инвайт-ссылками закрытых каналов
(`https://telegram.me/+abc...`), для которых @-префикс не годится.
"""
import re
from typing import Optional

_TG_RE_INVITE = re.compile(r"^\+[A-Za-z0-9_-]+$")
_TG_RE_USERNAME = re.compile(r"^[A-Za-z0-9_]{4,32}$")


def normalize_telegram_link(s: Optional[str]) -> str:
    """Любой ввод → корректный https-URL Telegram, либо исходная строка.

    Поддерживает:
    - `https://telegram.me/foo`, `http://t.me/foo`, `t.me/foo`, `telegram.me/foo`
    - `https://telegram.me/+abc` (закрытый канал — инвайт)
    - `@username`              → `https://telegram.me/username`
    - `+abc` (без хоста)       → `https://telegram.me/+abc`
    - `username` (без префикса) → `https://telegram.me/username`
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
        return f"https://telegram.me/{m.group(1).strip('/')}"
    if raw.startswith("t.me/") or raw.startswith("telegram.me/"):
        path = raw.split("/", 1)[1].strip("/")
        return f"https://telegram.me/{path}" if path else raw
    if raw.startswith("@"):
        u = raw[1:]
        # `@+abcDEF...` — артефакт старого кода (он лепил @ ко всему, включая
        # инвайт-коды закрытых каналов). Чиним и такие записи.
        if u.startswith("+") and _TG_RE_INVITE.match(u):
            return f"https://telegram.me/{u}"
        if _TG_RE_USERNAME.match(u):
            return f"https://telegram.me/{u}"
        return raw
    if _TG_RE_INVITE.match(raw):
        return f"https://telegram.me/{raw}"
    if _TG_RE_USERNAME.match(raw):
        return f"https://telegram.me/{raw}"
    return raw


def telegram_api_id(s: Optional[str]) -> str:
    """Возвращает идентификатор канала для Telegram Bot API (`getChatMember`).

    Bot API принимает `@channelname` или числовой chat_id. Из любого ввода
    выделяем username (если он есть) и отдаём с префиксом `@`. Для инвайт-ссылок
    закрытых каналов (`+abc`) возвращаем пустую строку — getChatMember
    с инвайт-кодом не работает, проверить подписку этим способом нельзя.
    """
    norm = normalize_telegram_link(s)
    if not norm.startswith("https://telegram.me/"):
        return ""
    path = norm[len("https://telegram.me/"):].strip("/")
    if not path or path.startswith("+"):
        return ""
    if "/" in path:  # вида `https://telegram.me/foo/123` — берём только канал
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


def normalize_telegram_channels(value) -> list[dict]:
    """Нормализует массив TG-каналов основателя `social_links.telegram_channels`.

    На входе ожидается список словарей со свободной формой; на выходе —
    канонизированный список:
        [{"url": "https://telegram.me/...", "chat_id": "-100..." | "", "name": "..."}]

    Правила:
      - url нормализуется через normalize_telegram_link, пустой url → элемент отбрасывается;
      - chat_id хранится строкой, цифры с одним минусом в начале; невалид → "";
      - name просто trim, максимум 60 символов;
      - дубли по url убираются (первый выигрывает);
      - порядок сохраняется (первый элемент = главный).
    """
    if not isinstance(value, list):
        return []
    seen_urls: set[str] = set()
    out: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        raw_url = item.get("url") or ""
        url = normalize_telegram_link(raw_url)
        if not url:
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)
        raw_cid = str(item.get("chat_id") or "").strip()
        # цифры + один минус в начале
        cid = ""
        if raw_cid:
            digits = "".join(ch for ch in raw_cid if ch.isdigit())
            sign = "-" if raw_cid.lstrip().startswith("-") else ""
            cid = sign + digits if digits else ""
        name = (item.get("name") or "").strip()[:60]
        out.append({"url": url, "chat_id": cid, "name": name})
    return out


def normalize_max_channels(value) -> list[dict]:
    """Нормализует массив MAX-каналов основателя `social_links.max_channels`.

    Формат элемента: {"url": "...", "chat_id": "" , "name": "..."}.
    У MAX нет публичного API для получения chat_id по ссылке (в отличие от TG
    getChat), поэтому chat_id вводится вручную или остаётся пустым.
    url нормализуется мягко: trim + https:// если схемы нет; пустой → отбрасывается.
    Дубли по url убираются, порядок сохраняется (первый = главный).
    """
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = (item.get("url") or "").strip()
        if not url:
            continue
        if not url.startswith("http://") and not url.startswith("https://"):
            url = "https://" + url.lstrip("/")
        if url in seen:
            continue
        seen.add(url)
        raw_cid = str(item.get("chat_id") or "").strip()
        cid = ""
        if raw_cid:
            digits = "".join(ch for ch in raw_cid if ch.isdigit())
            sign = "-" if raw_cid.lstrip().startswith("-") else ""
            cid = sign + digits if digits else ""
        name = (item.get("name") or "").strip()[:60]
        out.append({"url": url, "chat_id": cid, "name": name})
    return out


def normalize_vk_channels(value) -> list[dict]:
    """Нормализует массив VK-сообществ основателя `social_links.vk_channels`.

    Формат элемента: {"url": "...", "group_id": "", "name": "..."}.
    url — ссылка на сообщество (vk.com/club123 или vk.com/screenname), мягкая
    нормализация (trim + https://). group_id — числовой id сообщества для
    groups.isMember; резолвится автоматически из url при сохранении в
    client_profile (через VK API resolveScreenName), здесь только чистим.
    Дубли по url убираются, порядок сохраняется (первый = главный).
    """
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = (item.get("url") or "").strip()
        if not url:
            continue
        url = normalize_vk_link(url)
        if not url or url in seen:
            continue
        seen.add(url)
        raw_gid = str(item.get("group_id") or "").strip()
        gid = "".join(ch for ch in raw_gid if ch.isdigit())  # group_id всегда положительный
        name = (item.get("name") or "").strip()[:60]
        out.append({"url": url, "group_id": gid, "name": name})
    return out


def get_founder_vk_channels(social: Optional[dict]) -> list[dict]:
    """Массив VK-сообществ основателя. Fallback на legacy одиночный `vk`+`vk_group_id`."""
    if not isinstance(social, dict):
        return []
    raw = social.get("vk_channels")
    if isinstance(raw, list) and raw:
        return normalize_vk_channels(raw)
    legacy_url = (social.get("vk") or "").strip()
    if legacy_url:
        return normalize_vk_channels([{
            "url": legacy_url,
            "group_id": social.get("vk_group_id"),
            "name": "",
        }])
    return []


def get_founder_max_channels(social: Optional[dict]) -> list[dict]:
    """Массив MAX-каналов основателя. Fallback на legacy одиночный `max`."""
    if not isinstance(social, dict):
        return []
    raw = social.get("max_channels")
    if isinstance(raw, list) and raw:
        return normalize_max_channels(raw)
    legacy_url = (social.get("max") or "").strip()
    if legacy_url:
        return normalize_max_channels([{
            "url": legacy_url,
            "chat_id": "",
            "name": "",
        }])
    return []


def get_founder_tg_channels(social: Optional[dict]) -> list[dict]:
    """Достаёт массив TG-каналов основателя из социал-линков клиента.

    Возвращает уже нормализованный список (см. normalize_telegram_channels).
    Если есть только legacy-ключи `telegram`/`telegram_chat_id` (до миграции 114),
    конвертирует их на лету в массив из одного элемента — чтобы код работал
    и до, и после миграции.
    """
    if not isinstance(social, dict):
        return []
    raw = social.get("telegram_channels")
    if isinstance(raw, list) and raw:
        return normalize_telegram_channels(raw)
    legacy_url = (social.get("telegram") or "").strip()
    if legacy_url:
        return normalize_telegram_channels([{
            "url": legacy_url,
            "chat_id": social.get("telegram_chat_id"),
            "name": "",
        }])
    return []


def normalize_social_links(social: Optional[dict]) -> dict:
    """Нормализует все известные платформенные поля внутри social_links."""
    if not isinstance(social, dict):
        return {}
    out = dict(social)
    # Legacy одиночный TG-канал больше не поддерживается на запись —
    # если клиент прислал устаревшие ключи, переносим их в массив.
    if out.get("telegram") and not out.get("telegram_channels"):
        out["telegram_channels"] = [{
            "url": out.get("telegram"),
            "chat_id": out.get("telegram_chat_id"),
            "name": "",
        }]
    out.pop("telegram", None)
    out.pop("telegram_chat_id", None)
    if out.get("telegram_channels") is not None:
        out["telegram_channels"] = normalize_telegram_channels(out["telegram_channels"])
    if out.get("max_channels") is not None:
        out["max_channels"] = normalize_max_channels(out["max_channels"])
    if out.get("vk_channels") is not None:
        out["vk_channels"] = normalize_vk_channels(out["vk_channels"])
    if out.get("vk"):
        out["vk"] = normalize_vk_link(out["vk"])
    return out
