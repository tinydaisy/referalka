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


async def resolve_start_greeting(
    conn,
    client_id: int,
    *,
    greet_name: str = "",
) -> dict[str, Any]:
    """Резолвит приветствие на голый /start для VIP-бота клиента.

    :return: dict
      - kind='event'    → открыть событие: {'event_slug': str}
      - kind='greeting' → показать приветствие:
            {'text': str (HTML),
             'events_label': str, 'events_url': str,
             'owner_label': str,  'owner_url': str,
             'photo_url': str|None}
    """
    client = await conn.fetchrow(
        """SELECT id, name, brand_name,
                  profile_photo_url, owner_photo_url,
                  start_greeting_text,
                  start_btn_events_label, start_btn_owner_label,
                  start_mode, start_event_id
             FROM clients WHERE id = $1""",
        client_id,
    )
    if not client:
        return {"kind": "greeting", "text": "", "events_label": "📅 Все события",
                "events_url": f"https://pluson.ru/o/{client_id}",
                "owner_label": "🌐 Об основателе",
                "owner_url": f"https://pluson.ru/o/{client_id}?tab=ecosystem",
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

    return {
        "kind": "greeting",
        "text": text,
        "events_label": events_label,
        "events_url": f"https://pluson.ru/o/{client_id}",
        "owner_label": owner_label,
        "owner_url": f"https://pluson.ru/o/{client_id}?tab=ecosystem",
        "photo_url": photo_url,
    }


def greeting_text_plain(html_text: str) -> str:
    """Простой strip HTML-тегов <b>/<i> для площадок без HTML (VK/MAX plain)."""
    import re
    return re.sub(r"</?[a-zA-Z][^>]*>", "", html_text or "")
