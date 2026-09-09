"""
Адрес офлайн-события для ботов — ОДНА точка на все три площадки.

Кнопка «Адрес мероприятия» есть в меню TG, VK и MAX, а меню у них написаны
порознь (handlers/funnel.py, vk_event_menu.py, max_webhook.py). Текст и ссылка
на карту собираются здесь, чтобы человек в разных мессенджерах видел одно и то
же: три копии этой сборки разъехались бы на первой же правке — так уже
разъезжались подсчёт вклада в коллабе и сборка письма.

⚠️ Карта — ЯНДЕКС и БЕЗ КЛЮЧА. У Google встраивание требует API-ключа с
привязанной картой оплаты, а в России часть посетителей карту всё равно не
откроет. Яндекс принимает адрес обычной ссылкой.
"""
from __future__ import annotations

import html as _html
from urllib.parse import quote


# Название кнопки по умолчанию. Клиент может задать своё в настройках события
# (`events.address_button_label`) — например «Как добраться» или «Где мы».
DEFAULT_ADDRESS_BUTTON_LABEL = "Адрес мероприятия"

# Поля, которые обязаны попасть в SELECT события, чтобы позвать функции ниже.
# Вынесены строкой, потому что запрос события в каждом боте свой.
ADDRESS_SQL_FIELDS = "e.is_offline, e.address, e.address_button_label"


def maps_url(address: str) -> str:
    """Ссылка на Яндекс.Карты по тексту адреса.

    ⚠️ Веб-ссылка, а не `yandexmaps://`: приложения у человека может не быть, и
    схема открыла бы пустоту. Веб сам предложит приложение, если оно стоит.
    """
    return f"https://yandex.ru/maps/?text={quote(address or '', safe='')}"


def has_address(ev) -> bool:
    """Показывать ли кнопку адреса у этого события.

    ⚠️ Решает ГАЛОЧКА «офлайн», а не заполненность поля: в `events.address`
    исторически кладут и ссылку на трансляцию, и карта повела бы человека по
    обрывку URL.
    """
    try:
        offline = bool(ev["is_offline"])
        addr = (ev["address"] or "").strip()
    except (KeyError, TypeError):
        return False
    return offline and bool(addr)


def button_label(ev) -> str:
    """Надпись на кнопке — своя у клиента либо «Адрес мероприятия»."""
    try:
        custom = (ev["address_button_label"] or "").strip()
    except (KeyError, TypeError):
        custom = ""
    return custom or DEFAULT_ADDRESS_BUTTON_LABEL


def address_text(ev, *, html: bool = True) -> str:
    """Текст сообщения с адресом.

    `html=False` — для VK и MAX-веток, где разметка уходит тегами в текст.
    """
    addr = (ev["address"] or "").strip()
    title = (ev["title"] or "").strip()
    if html:
        head = f"<b>{_html.escape(button_label(ev))}</b>"
        body = _html.escape(addr)
        tail = _html.escape(title)
    else:
        head = button_label(ev)
        body = addr
        tail = title
    text = f"{head}\n\n{body}"
    if tail:
        text += f"\n\n{tail}"
    return text
