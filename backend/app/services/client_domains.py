"""
Свои домены клиента — единая точка сборки публичных ссылок.

Зачем. Всё, что клиент отдаёт своей аудитории (лендинги событий, кабинет
спикера и жюри, турнирные таблицы, воронки лид-магнитов, страница оферты и
политики ПД), должно открываться на ЕГО домене, а не на pluson.ru. Дашборд
клиента (/dashboard, /admin) остаётся на pluson.ru — там JWT, cookies и
вебхуки платёжек завязаны на один origin.

⚠️ ГЛАВНОЕ ПРАВИЛО. Публичную ссылку собирать ТОЛЬКО через `client_public_url`
(async, ходит в БД) или `public_url_for` (если базовый адрес уже получен).
Никаких литералов "https://pluson.ru" в коде — иначе клиент со своим доменом
получит в рассылке чужой адрес, и часть ссылок разъедется. Так уже было до
миграции 270: домен был захардкожен в 246 местах и его нельзя было сменить в
принципе.

⚠️ Mini App НЕ переезжает на домен клиента. Адрес Mini App вбивается вручную
в @BotFather (и в настройках бота MAX), он один на бота и сменить его на
лету нельзя. Ссылки вида /c/{id}/tg/ всегда остаются на основном домене —
`platform_base_url()`. Для человека это незаметно: Mini App открывается
внутри мессенджера, адресной строки там нет.
"""
from __future__ import annotations

import re
import time
from typing import Optional

from app.config import settings


# Базовый адрес платформы. Единственное место, где читается настройка.
def platform_base_url() -> str:
    """Основной адрес ПЛЮСОНа — https://pluson.ru на проде.

    Используется для: дашборда, Mini App, вебхуков платёжек, реф-ссылок
    регистрации в саму платформу и как fallback, когда у клиента нет
    своего домена.
    """
    raw = (settings.frontend_url or settings.app_url or "").strip()
    if not raw:
        return "https://pluson.ru"
    return raw.rstrip("/")


# ── Кеш резолва ─────────────────────────────────────────────────────────────
# Домен клиента нужен на КАЖДОЙ публичной странице и в каждой ссылке рассылки
# (а рассылка — это тысячи сообщений подряд). Ходить в БД каждый раз нельзя,
# поэтому держим короткий TTL-кеш в памяти процесса. TTL маленький, чтобы
# смена домена применялась быстро и без рестарта.
_TTL_SEC = 60.0

# client_id → (base_url, expires_at)
_by_client: dict[int, tuple[str, float]] = {}
# domain → (client_id, expires_at); None = домен нам не принадлежит
_by_domain: dict[str, tuple[Optional[int], float]] = {}


def invalidate_cache(*, client_id: int | None = None, domain: str | None = None) -> None:
    """Сбросить кеш после изменения домена (добавили / выпустили сертификат / удалили)."""
    if client_id is None and domain is None:
        _by_client.clear()
        _by_domain.clear()
        return
    if client_id is not None:
        _by_client.pop(client_id, None)
    if domain is not None:
        _by_domain.pop(normalize_domain(domain), None)


# ── Нормализация и валидация ────────────────────────────────────────────────

# Домен: метки из букв/цифр/дефисов, дефис не с краю, TLD хотя бы 2 буквы.
_DOMAIN_RE = re.compile(
    r"^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)


def normalize_domain(raw: str | None) -> str:
    """Привести ввод клиента к каноничному виду: lp.example.ru

    Принимаем как есть всё, что человек может скопировать из браузера:
    «https://LP.Example.RU/», «lp.example.ru.», « lp.example.ru ».
    """
    s = (raw or "").strip().lower()
    if not s:
        return ""
    s = re.sub(r"^[a-z]+://", "", s)   # схема
    s = s.split("/", 1)[0]             # путь
    s = s.split("?", 1)[0]
    s = s.split("#", 1)[0]
    s = s.split(":", 1)[0]             # порт
    s = s.rstrip(".")                  # завершающая точка из DNS-нотации
    if s.startswith("www."):
        # www отбрасываем: сертификат и CNAME клиент делает на конкретное имя,
        # а www.<домен> — это отдельная DNS-запись, которой у него может не быть.
        s = s[4:]
    return s


def validate_domain(raw: str | None) -> tuple[str, str]:
    """(нормализованный домен, текст ошибки). Ошибка пустая → всё хорошо."""
    d = normalize_domain(raw)
    if not d:
        return "", "Укажите домен"
    if len(d) > 253:
        return "", "Слишком длинный домен"
    if not _DOMAIN_RE.match(d):
        return "", "Похоже, это не домен. Пример: lp.вашсайт.ru (латиницей)"

    # Свой же домен как «клиентский» принимать нельзя: на него уже есть
    # server-блок, и попытка выпустить сертификат сломает основной сайт.
    base = normalize_domain(platform_base_url())
    if base and (d == base or d.endswith("." + base)):
        return "", "Этот домен принадлежит платформе — укажите свой"
    return d, ""


# Домены второго уровня, где «корень» на самом деле третий уровень:
# example.co.uk / example.com.ru — это корень, а не поддомен.
_MULTI_LEVEL_TLDS = {
    "co.uk", "org.uk", "me.uk", "com.au", "net.au", "co.nz", "co.jp",
    "com.br", "com.tr", "com.ua", "com.ru", "net.ru", "org.ru", "pp.ru",
}


def is_apex_domain(domain: str | None) -> bool:
    """Корень домена (example.ru) или поддомен (lp.example.ru)?

    ⚠️ От этого зависит инструкция в кабинете: на КОРНЕ CNAME невозможен
    в принципе (запрет стандарта DNS — у корня обязаны быть NS и SOA, а
    CNAME означает «других записей нет»). Ни один регистратор его не даст.
    Поэтому корню показываем A-запись, поддомену — CNAME.
    """
    d = normalize_domain(domain)
    if not d:
        return False
    parts = d.split(".")
    if len(parts) <= 2:
        return True
    if ".".join(parts[-2:]) in _MULTI_LEVEL_TLDS:
        return len(parts) == 3
    return False


# ── Резолв ──────────────────────────────────────────────────────────────────

async def client_public_url(db, client_id: int | None) -> str:
    """Базовый адрес для ПУБЛИЧНЫХ страниц клиента — без завершающего слеша.

    Свой домен клиента, если он подключён и работает; иначе pluson.ru.
    Именно эту функцию звать перед сборкой любой ссылки, которая уйдёт
    аудитории: в рассылку, в бота, в письмо, в QR-код.
    """
    fallback = platform_base_url()
    if not client_id:
        return fallback

    now = time.monotonic()
    hit = _by_client.get(client_id)
    if hit and hit[1] > now:
        return hit[0]

    url = fallback
    try:
        row = await db.fetchrow(
            """
            SELECT domain
              FROM client_domains
             WHERE client_id = $1
               AND kind = 'landing'
               AND status = 'active'
               AND is_primary
             LIMIT 1
            """,
            client_id,
        )
        if row and row["domain"]:
            url = f"https://{row['domain']}"
    except Exception:
        # Таблицы ещё нет (миграция не накатана) или БД недоступна — публичные
        # ссылки важнее точности домена, поэтому молча отдаём основной адрес.
        return fallback

    _by_client[client_id] = (url, now + _TTL_SEC)
    return url


async def client_id_by_domain(db, host: str | None) -> Optional[int]:
    """Чей это домен. Для резолва клиента по заголовку Host.

    None → домен не наш (или основной pluson.ru) — работаем как раньше.
    """
    d = normalize_domain(host)
    if not d:
        return None

    base = normalize_domain(platform_base_url())
    if d == base:
        return None

    now = time.monotonic()
    hit = _by_domain.get(d)
    if hit and hit[1] > now:
        return hit[0]

    cid: Optional[int] = None
    try:
        row = await db.fetchrow(
            """
            SELECT client_id
              FROM client_domains
             WHERE domain = $1
               AND kind = 'landing'
               AND status = 'active'
             LIMIT 1
            """,
            d,
        )
        if row:
            cid = row["client_id"]
    except Exception:
        return None

    _by_domain[d] = (cid, now + _TTL_SEC)
    return cid


async def domain_home_path(db, host: str | None) -> Optional[str]:
    """Куда вести с КОРНЯ клиентского домена (миграция 278).

    Возвращает путь вида `/o/62?tab=about` или `/e/e2rw7`, либо None —
    домен не наш, тогда `/` отдаёт лендинг ПЛЮСОНа, как и раньше.

    ⚠️ Без этой ветки на корне клиентского домена открывалась НАША продающая
    страница: nginx отдаёт всё неизвестное в Next.js, а `/` там занят
    лендингом платформы. Клиент платил за домен и рекламировал нас.

    ⚠️ Кеш здесь НЕ используется: настройку меняют в кабинете и сразу идут
    проверять на домене. Запрос лёгкий и только на корень — не на каждую
    страницу, поэтому 60-секундный кеш только мешал бы.
    """
    d = normalize_domain(host)
    if not d or d == normalize_domain(platform_base_url()):
        return None

    try:
        row = await db.fetchrow(
            """
            SELECT cd.client_id, cd.home_kind, e.slug AS event_slug
              FROM client_domains cd
              LEFT JOIN events e ON e.id = cd.home_event_id
             WHERE cd.domain = $1
               AND cd.kind = 'landing'
               AND cd.status = 'active'
             LIMIT 1
            """,
            d,
        )
    except Exception:
        # Миграция не накатана или БД недоступна — пусть откроется хоть что-то.
        return None

    if not row:
        return None

    kind = row["home_kind"] or "about"
    # Событие удалили (home_event_id → NULL) или у него нет адреса — не роняем
    # корень в 404, а показываем витрину: там есть всё остальное.
    if kind == "event" and row["event_slug"]:
        return f"/e/{row['event_slug']}"
    if kind == "events":
        return f"/o/{row['client_id']}"
    return f"/o/{row['client_id']}?tab=about"


def public_url_for(base_url: str | None, path: str = "") -> str:
    """Склеить базовый адрес и путь, не плодя двойные слеши.

    Когда базовый адрес уже получен (например, один раз на всю рассылку),
    ссылки собираются этой функцией — без похода в БД на каждое сообщение.
    """
    base = (base_url or platform_base_url()).rstrip("/")
    if not path:
        return base
    return f"{base}/{path.lstrip('/')}"


async def client_public_link(db, client_id: int | None, path: str = "") -> str:
    """Готовая публичная ссылка клиента: резолв домена + путь одной строкой."""
    return public_url_for(await client_public_url(db, client_id), path)


# ── Почта ───────────────────────────────────────────────────────────────────

async def client_mail_domain(db, client_id: int | None) -> Optional[dict]:
    """Настройки отправителя писем клиента, если его почтовый домен работает.

    Возвращает {domain, local, from_name, selector} либо None — тогда письма
    уходят с системного адреса на pluson.ru, как и раньше.
    """
    if not client_id:
        return None
    try:
        row = await db.fetchrow(
            """
            SELECT domain, mail_from_local, mail_from_name, dkim_selector
              FROM client_domains
             WHERE client_id = $1
               AND kind = 'mail'
               AND status = 'active'
               AND is_primary
             LIMIT 1
            """,
            client_id,
        )
    except Exception:
        return None
    if not row or not row["domain"]:
        return None
    return {
        "domain": row["domain"],
        "local": (row["mail_from_local"] or "noreply").strip() or "noreply",
        "from_name": (row["mail_from_name"] or "").strip(),
        "selector": (row["dkim_selector"] or "").strip(),
    }
