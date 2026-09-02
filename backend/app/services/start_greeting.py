"""Единый резолвер приветствия на голый /start для всех площадок (TG/VK/MAX).

Telegram-бот ([backend/bot/handlers/start.py](backend/bot/handlers/start.py)
`_handle_vip_direct_start`) при `/start` без payload на VIP-боте клиента читает
из настроек клиента:
  • start_mode='event' + start_event_id → открыть СТАНДАРТНЫЙ флоу события
    (афиша + «Зарегистрироваться» / меню кабинета), как по ссылке ref_pg{slug};
  • иначе — приветствие: кастомный текст (start_greeting_text c {имя}/{бренд})
    либо дефолт + 2 кнопки «Все события» / «Об основателе».

MAX и VK раньше игнорировали эти настройки — отдавали захардкоженное
«Выберите событие». Этот модуль выносит логику в одно место, чтобы все три
площадки вели себя одинаково.

Возвращает dict-описание, а сама отправка (текст/кнопки/фото) — на стороне
вызывающего адаптера (у каждой площадки свой формат кнопок и API).
"""
from __future__ import annotations

import html as _html
from typing import Any

from app.services.client_domains import client_public_url, public_url_for
from app.services.share_links import TG_DOMAIN


async def resolve_start_greeting(
    conn,
    client_id: int,
    *,
    greet_name: str = "",
    platform: str = "telegram",
) -> dict[str, Any]:
    """Резолвит приветствие на голый /start для VIP-бота клиента.

    :return: dict
      - kind='event'    → открыть событие: {'event_slug': str}
      - kind='greeting' → показать приветствие:
            {'text': str (HTML),
             'buttons': [{'kind': 'events'|'owner'|'custom',
                          'label': str, 'url': str}],
             'photo_url': str|None,
             # legacy-поля для обратной совместимости старых вызовов:
             'events_label', 'events_url', 'owner_label', 'owner_url'}
    """
    client = await conn.fetchrow(
        """SELECT id, name, brand_name,
                  profile_photo_url, owner_photo_url,
                  start_greeting_text,
                  start_btn_events_label, start_btn_owner_label,
                  start_buttons,
                  start_mode, start_event_id,
                  start_lead_magnet_id, start_package_id
             FROM clients WHERE id = $1""",
        client_id,
    )
    # Страница «/o/{client_id}» (события клиента + карточка основателя) —
    # публичная витрина клиента, поэтому открываем её на его домене.
    base_url = await client_public_url(conn, client_id)

    if not client:
        return {"kind": "greeting", "text": "",
                "buttons": _default_buttons(client_id, None, None, base_url),
                "events_label": "📅 Все события",
                "events_url": _events_url(client_id, base_url),
                "owner_label": "🌐 Об основателе",
                "owner_url": _owner_url(client_id, base_url),
                "photo_url": None}

    # Режим «открывать конкретное событие» — отдаём slug, адаптер запустит штатный
    # флоу события (ref_pg{slug}).
    if client["start_mode"] == "event" and client["start_event_id"]:
        slug = await conn.fetchval(
            """SELECT e.slug FROM events e
                WHERE e.id = $1 AND e.status = 'published'
                  AND EXISTS (SELECT 1 FROM event_owners eo
                               WHERE eo.event_id = e.id AND eo.client_id = $2
                                 AND eo.status = 'accepted')""",
            client["start_event_id"], client_id,
        )
        if slug:
            return {"kind": "event", "event_slug": slug}

    # Режим «открывать воронку лид-магнита» — отдаём kind+slug, адаптер запустит
    # тот же путь, что и /start m_<slug> / p_<slug> (см. bot/handlers/start.py).
    if client["start_mode"] == "lead_magnet":
        if client["start_lead_magnet_id"]:
            lm_slug = await conn.fetchval(
                "SELECT slug FROM lead_magnets WHERE id=$1 AND client_id=$2",
                client["start_lead_magnet_id"], client_id,
            )
            if lm_slug:
                return {"kind": "lead_magnet", "lm_kind": "m", "slug": lm_slug}
        if client["start_package_id"]:
            pkg_slug = await conn.fetchval(
                "SELECT slug FROM lead_magnet_packages WHERE id=$1 AND client_id=$2",
                client["start_package_id"], client_id,
            )
            if pkg_slug:
                return {"kind": "lead_magnet", "lm_kind": "p", "slug": pkg_slug}
        # лид-магнит выбран, но не нашёлся → падаем на приветствие ниже

    brand_name = (client["brand_name"] or client["name"] or "").strip()
    custom_greeting = (client["start_greeting_text"] or "").strip()

    if custom_greeting:
        text = (custom_greeting
                .replace("{имя}", _html.escape(greet_name or ""))
                .replace("{бренд}", _html.escape(brand_name)))
    else:
        greeting = (f"Привет, {_html.escape(greet_name)}! 👋"
                    if greet_name else "Привет! 👋")
        lines = [greeting, ""]
        lines.append(f"Добро пожаловать в бот <b>{_html.escape(brand_name)}</b>."
                     if brand_name else "Добро пожаловать!")
        lines.append("")
        lines.append("Загляните в события и узнайте об организаторе по кнопкам ниже 👇")
        text = "\n".join(lines)

    events_label = (client["start_btn_events_label"] or "").strip() or "📅 Все события"
    owner_label = (client["start_btn_owner_label"] or "").strip() or "🌐 Об основателе"
    photo_url = client["owner_photo_url"] or client["profile_photo_url"]

    # Реф-ссылку на ПЛЮСОН готовим заранее: она зависит от площадки бота
    # и требует запроса в БД, а сам разбор кнопок — обычная функция.
    plusson_url = await _plusson_ref_url(conn, client_id, platform)

    buttons = _resolve_buttons(
        client_id,
        client["start_buttons"],
        client["start_btn_events_label"],
        client["start_btn_owner_label"],
        base_url,
        plusson_url,
    )

    return {
        "kind": "greeting",
        "text": text,
        "buttons": buttons,
        # legacy-поля — оставлены для старых вызовов, которые ещё их читают
        "events_label": events_label,
        "events_url": _events_url(client_id, base_url),
        "owner_label": owner_label,
        "owner_url": _owner_url(client_id, base_url),
        "photo_url": photo_url,
    }


def normalize_button_url(raw: str) -> str:
    """Чинит частые опечатки в URL кастомной кнопки. Пусто → '' (кнопку выкинуть).

    Telegram отвергает ВСЁ сообщение целиком, если хоть одна inline-кнопка имеет
    кривой URL («Wrong HTTP URL») — тогда клиент вместо своего приветствия видит
    системный фолбэк. Поэтому чиним и валидируем здесь, в одной точке для TG/VK/MAX.

    Правила:
      · `https//t.me/x`, `https:/t.me/x`, `http//x` → `https://t.me/x`
      · `t.me/x`, `pluson.ru/x`, `@nick` → `https://…`
      · кириллица и пробелы в пути/квери — процент-кодирование (TG требует ASCII)
      · tg://, mailto:, tel: — пропускаем как есть
    """
    import re
    from urllib.parse import quote, urlsplit, urlunsplit

    s = (raw or "").strip()
    if not s:
        return ""

    if s.startswith(("tg://", "mailto:", "tel:")):
        return s

    # https//host, https:/host, http//host  →  scheme://host
    s = re.sub(r"^(https?)(?::?/{1,2}|:)(?=[^/])", r"\1://", s, flags=re.I)
    # @nickname → t.me/nickname
    if s.startswith("@"):
        s = f"https://{TG_DOMAIN}/{s[1:]}"
    if not re.match(r"^https?://", s, flags=re.I):
        s = f"https://{s.lstrip('/')}"

    try:
        parts = urlsplit(s)
    except ValueError:
        return ""
    # Хост должен быть похож на домен: без пробелов, с точкой (или localhost).
    host = parts.netloc
    if not host or " " in host or ("." not in host and host != "localhost"):
        return ""

    # Telegram принимает только ASCII-URL: кириллицу в пути/квери кодируем.
    path = quote(parts.path, safe="/%:@!$&'()*+,;=~-._")
    query = quote(parts.query, safe="=&%:@!$'()*+,;/?~-._")
    fragment = quote(parts.fragment, safe="%:@!$&'()*+,;=/?~-._")
    return urlunsplit((parts.scheme.lower(), parts.netloc, path, query, fragment))


# ⚠️ base_url — уже отрезолвленный публичный адрес клиента. Эти хелперы
# синхронные (их зовут и из TG-бота, и отсюда), поэтому в БД не ходят: базу
# передаёт вызывающий, а без неё падаем на основной домен платформы.
def _events_url(client_id: int, base_url: str | None = None) -> str:
    return public_url_for(base_url, f"o/{client_id}")


def _owner_url(client_id: int, base_url: str | None = None) -> str:
    return public_url_for(base_url, f"o/{client_id}?tab=ecosystem")


async def _plusson_ref_url(conn, client_id: int, platform: str) -> str:
    """Реф-ссылка клиента на ПЛЮСОН — В БОТ ТОЙ ЖЕ ПЛОЩАДКИ.

    ⚠️ Человек нажимает кнопку в MAX — вести его в Telegram бессмысленно: он
    там может не быть вовсе. Поэтому для MAX отдаём max.ru, для остальных —
    Telegram.

    ⚠️ Handle MAX-бота берём ИЗ БАЗЫ и только с непустым токеном: у сервисного
    клиента есть карточка MAX-канала без токена — бот за ней не заведён, и
    ссылка вела бы в пустоту (та же оговорка, что в реф-программе).
    """
    code = await conn.fetchval(
        "SELECT referral_code FROM clients WHERE id = $1", client_id)
    if not code:
        return ""

    if platform == "max":
        handle = await conn.fetchval(
            """SELECT ch.handle
                 FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                 JOIN clients cl ON cl.id = cc.client_id
                WHERE ch.platform_slug = 'max'
                  AND COALESCE(ch.handle, '') <> ''
                  AND COALESCE(ch.bot_token, '') <> ''
                ORDER BY cl.is_system_service DESC, cc.is_active DESC, ch.id
                LIMIT 1"""
        )
        if handle:
            return f"https://max.ru/{handle.lstrip('@')}?start=ref{code}"
        # MAX-бота нет — ведём в Telegram, это лучше нерабочей кнопки.

    from app.services.share_links import PLUSON_TG_HANDLE
    return f"https://{TG_DOMAIN}/{PLUSON_TG_HANDLE}?start=ref{code}"


def _product_url(slug: str, base_url: str | None = None) -> str:
    """Публичная страница продукта. Клиент выбирает продукт, адрес ставится сам."""
    return public_url_for(base_url, f"pr/{slug}")


def _default_buttons(client_id: int, events_label, owner_label,
                     base_url: str | None = None) -> list[dict]:
    """Две дефолтные кнопки (события + об основателе) — обратная совместимость."""
    ev = (events_label or "").strip() or "📅 Все события"
    ow = (owner_label or "").strip() or "🌐 Об основателе"
    return [
        {"kind": "events", "label": ev, "url": _events_url(client_id, base_url)},
        {"kind": "owner", "label": ow, "url": _owner_url(client_id, base_url)},
    ]


def _resolve_buttons(client_id: int, start_buttons, events_label, owner_label,
                     base_url: str | None = None,
                     plusson_url: str = "") -> list[dict]:
    """Разбирает clients.start_buttons (JSONB) в список готовых кнопок.

    Каждая кнопка: {'kind': 'events'|'owner'|'custom', 'label': str, 'url': str}.
    Для events/owner URL проставляется автоматически (клиент задаёт только текст),
    для custom берётся заданный клиентом URL.

    Пусто/невалидно → две дефолтные кнопки из старых полей (совместимость).
    Ограничение — до 5 кнопок.
    """
    import json as _json
    raw = start_buttons
    if isinstance(raw, str):
        try:
            raw = _json.loads(raw)
        except Exception:
            raw = None
    if not isinstance(raw, list) or not raw:
        return _default_buttons(client_id, events_label, owner_label, base_url)

    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = (item.get("type") or item.get("kind") or "custom").strip()
        label = (item.get("label") or "").strip()
        if kind == "events":
            out.append({"kind": "events",
                        "label": label or "📅 Все события",
                        "url": _events_url(client_id, base_url)})
        elif kind == "owner":
            out.append({"kind": "owner",
                        "label": label or "🌐 Об основателе",
                        "url": _owner_url(client_id, base_url)})
        elif kind == "plusson":
            # Реф-ссылка клиента на ПЛЮСОН — в бот ТОЙ ЖЕ площадки, где
            # человек нажал кнопку (см. _plusson_ref_url).
            if plusson_url:
                out.append({"kind": "plusson",
                            "label": label or "🎁 ПЛЮСОН",
                            "url": plusson_url})
        elif kind == "product":
            # ⚠️ Храним slug, а не готовый адрес: у клиента может быть свой
            # домен, и вшитая ссылка на pluson.ru перестала бы вести к нему.
            slug = (item.get("product_slug") or "").strip()
            if slug:
                out.append({"kind": "product",
                            "label": label or "🎁 Продукт",
                            "url": _product_url(slug, base_url)})
        else:  # custom
            # Кривой URL (напр. `https//t.me/…` без двоеточия) не должен ронять
            # ВСЁ приветствие: чиним что можем, безнадёжную кнопку — пропускаем.
            url = normalize_button_url(item.get("url") or "")
            if label and url:
                out.append({"kind": "custom", "label": label, "url": url})
        if len(out) >= 5:
            break

    return out or _default_buttons(client_id, events_label, owner_label, base_url)


def greeting_text_plain(html_text: str) -> str:
    """Простой strip HTML-тегов <b>/<i> для площадок без HTML (VK/MAX plain)."""
    import re
    return re.sub(r"</?[a-zA-Z][^>]*>", "", html_text or "")
