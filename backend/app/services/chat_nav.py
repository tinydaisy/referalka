"""Навигация по чату события — сборка пунктов со ссылками ПОД ПЛОЩАДКУ.

Шаблон `chat_nav` — один закреплённый пост в чате события: куда идти за
подарками, где правила, куда писать в поддержку, какие офферы открыты.

⚠️ Зачем отдельный сборщик, а не обычные плейсхолдеры в тексте. Ссылки здесь
РАЗНЫЕ у каждой площадки: в чате ВКонтакте телеграмная ссылка бесполезна, а
бот у клиента может быть подключён не везде. Плоский текст шаблона такого не
выражает — поэтому пункты хранятся списком (`broadcast_templates.nav_items`),
а текст получает их уже собранными, на место `{chat_nav_items}`.

⚠️ Пункт без ссылки НЕ вставляется вовсе (решение владельца 21.09.2026):
правила чата есть не у всех, а «3. Правила нетворкинга:» с пустотой под
двоеточием читается как поломка. Нумерация сквозная и считается ПОСЛЕ отсева,
иначе в сообщении вышло бы «1, 2, 4».

Виды пунктов (`kind`):
    vip      — тариф события (`events.vip_url`, тот же источник, что {vip_url})
    cabinet  — кабинет участника, вкладка подарков («Привилегии», tab=game)
    support  — тех.поддержка (deeplink `evsupport_`, как {support_command})
    rules    — правила чата (ссылку клиент вписывает руками)
    link     — произвольная ссылка руками
    magnet   — лид-магнит/пакет (воронка в боте ХОЗЯИНА магнита)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

PLACEHOLDER = "{chat_nav_items}"

# Площадки, на которых бывает чат события. Email сюда не попадает: у письма
# нет «своей» площадки, для него берём телеграмный порядок (как в подарках).
_PLATFORMS = ("telegram", "vk", "max")


def parse_items(raw: Any) -> list[dict]:
    """`nav_items` из базы → список словарей.

    asyncpg отдаёт JSONB строкой, если на соединении не настроен декодер, —
    поэтому принимаем и строку, и уже разобранный список. Мусор не роняет
    рассылку: пункты не критичнее самого сообщения.
    """
    if not raw:
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            logger.warning("chat_nav: nav_items не разобрались как JSON")
            return []
    if not isinstance(raw, list):
        return []
    return [i for i in raw if isinstance(i, dict)]


async def resolve_nav_links(
    db,
    *,
    items: list[dict],
    event_id: int,
    client_id: int,
) -> list[dict]:
    """Для каждого пункта — ссылки по площадкам: `{telegram, vk, max}`.

    Резолвим ОДИН раз на всю отправку (а не на каждый чат): запросы в базу
    одинаковы для всех получателей, а чатов у события до трёх.

    Возвращает список `{label, links}` в исходном порядке. Отсев пустых и
    нумерация — в `render_nav_items`, у неё своя площадка.
    """
    from app.services.share_links import (
        build_gift_funnel_links_by_owner,
        build_support_command_links,
        get_client_bot_handles,
    )

    out: list[dict] = []

    # Ленивые «общие» данные: тянем, только если такой пункт реально есть.
    handles: Optional[dict] = None
    vip_url: Optional[str] = None
    cabinet_links: Optional[dict] = None

    for item in items:
        kind = (item.get("kind") or "").strip()
        label = (item.get("label") or "").strip()
        links: dict[str, str] = {}

        if kind in ("rules", "link"):
            # ⚠️⚠️ ССЫЛКА ЗАДАЁТСЯ ПО ПЛОЩАДКАМ (решение владельца 21.09.2026).
            # Правила нетворкинга — это ЗАКРЕПЛЁННЫЙ ПОСТ В САМОМ ЧАТЕ, а чат у
            # каждой площадки свой: в телеграмном чате свой закреп, во вкашном
            # свой. Одна ссылка на всех увела бы человека из ВК в Telegram —
            # туда, где он не состоит.
            #
            # `urls: {telegram, vk, max}` — основной формат. `url` (одна на всех)
            # оставлен для совместимости и для «своей ссылки», которая часто
            # действительно одна (лендинг, документ).
            by_pl = item.get("urls") or {}
            if isinstance(by_pl, dict):
                links = {p: (by_pl.get(p) or "").strip()
                         for p in _PLATFORMS if (by_pl.get(p) or "").strip()}
            common = (item.get("url") or "").strip()
            if common:
                # Общая ссылка добирает площадки, где своей не задано.
                for p in _PLATFORMS:
                    links.setdefault(p, common)

        elif kind == "vip":
            if vip_url is None:
                vip_url = (await db.fetchval(
                    "SELECT vip_url FROM events WHERE id = $1", event_id) or "")
            if vip_url:
                links = {p: vip_url for p in _PLATFORMS}

        elif kind == "support":
            if handles is None:
                handles = await get_client_bot_handles(db, client_id)
            links = {k: v for k, v in
                     build_support_command_links(handles, event_id).items() if v}

        elif kind == "cabinet":
            if cabinet_links is None:
                cabinet_links = await _build_cabinet_links(db, event_id, client_id)
            links = dict(cabinet_links)

        elif kind == "magnet":
            slug = (item.get("magnet_slug") or "").strip()
            mkind = (item.get("magnet_kind") or "m").strip()
            if slug:
                links = {k: v for k, v in
                         (await build_gift_funnel_links_by_owner(db, mkind, slug)).items() if v}

        if label or links:
            # ⚠️ `own_only` — ссылка имеет смысл ТОЛЬКО на своей площадке.
            # Правила нетворкинга лежат в закрепе КОНКРЕТНОГО чата: выдать
            # человеку в ВК ссылку «Через Телеграм: …» значит отправить его в
            # чат, где его нет. Лучше не показать пункт вовсе.
            out.append({"label": label, "links": links, "own_only": kind == "rules"})

    return out


async def _build_cabinet_links(db, event_id: int, client_id: int) -> dict[str, str]:
    """Ссылки на кабинет участника — вкладку подарков («Привилегии», tab=game).

    ⚠️ Вкладки «подарки» в Mini App нет: подарки живут ВНУТРИ вкладки
    «Привилегии» (`game`), и её название клиент настраивает сам. Ведём на саму
    вкладку, а не внутрь окна подарков (решение владельца 21.09.2026).

    ⚠️ Mini App или веб — по настройке КЛИЕНТА на каждую площадку
    (`resolve_event_link_mode`): у кого выбрана веб-версия, тому Mini App-ссылка
    открыла бы не то, что он настроил. MAX всегда идёт в бота — там Mini App не
    даёт подписки на бота, и человек остался бы без рассылок.

    ⚠️ Человек в чате не опознан (чат — не личка), поэтому ни `pid`, ни
    `contact_id` не подставляем: персональной метки у чата быть не может.
    Не зарегистрирован — бот/Mini App сам предложит регистрацию.
    """
    from app.services.share_links import (
        get_client_bot_handles,
        get_client_vk_app_id,
        get_event_disabled_platforms,
        max_link,
        resolve_event_link_mode,
        telegram_link,
        vk_link,
    )

    row = await db.fetchrow("SELECT slug FROM events WHERE id = $1", event_id)
    slug = (row["slug"] if row else "") or ""
    if not slug:
        return {}

    handles = await get_client_bot_handles(db, client_id)
    disabled = await get_event_disabled_platforms(db, event_slug=slug)
    links: dict[str, str] = {}

    if "telegram" not in disabled and handles.get("telegram"):
        mode = await resolve_event_link_mode(db, client_id=client_id, platform="telegram")
        url = telegram_link(slug, bot_handle=handles["telegram"], tab="game",
                            link_mode=mode, client_id=client_id)
        if url:
            links["telegram"] = url

    if "vk" not in disabled and handles.get("vk"):
        mode = await resolve_event_link_mode(db, client_id=client_id, platform="vk")
        app_id = await get_client_vk_app_id(db, client_id)
        url = vk_link(slug, app_id=app_id, tab="game", link_mode=mode)
        if url:
            links["vk"] = url

    if "max" not in disabled and handles.get("max"):
        # resolve_event_link_mode форсит MAX в 'bot' — зовём ради единой точки,
        # чтобы правило не разъехалось, если оно когда-нибудь изменится.
        mode = await resolve_event_link_mode(db, client_id=client_id, platform="max")
        url = max_link(slug, bot_handle=handles["max"], tab="game", link_mode=mode)
        if url:
            links["max"] = url

    return links


def render_nav_items(resolved: list[dict], platform: str) -> str:
    """Готовый текст пунктов для конкретной площадки.

    Формат — как в ТЗ владельца: строка подписи, ссылка под ней.

        1.Повысить тариф и получить доступ к Коллабораторной:
        https://…

    ⚠️ Нумерация считается ПОСЛЕ отсева пустых, поэтому идёт без пропусков.
    """
    from app.services.share_links import pick_gift_funnel_link

    lines: list[str] = []
    num = 0
    for item in resolved:
        links = item.get("links") or {}
        if not links:
            continue
        # Своя площадка есть → только она; нет → все имеющиеся с подписью
        # площадки. Ровно то же правило, что у подарков и ссылки регистрации
        # (pick_gift_funnel_link) — человек не должен молча получить ссылку в
        # мессенджер, которым не пользуется.
        #
        # ⚠️ Исключение — `own_only` (правила чата): чужую площадку НЕ
        # подставляем. Закреп с правилами лежит в конкретном чате, и ссылка на
        # телеграмный чат бесполезна тому, кто читает вкашный: пункт просто не
        # показываем, как и при пустой ссылке.
        if item.get("own_only"):
            url = (links.get(platform) or "").strip()
        else:
            url = pick_gift_funnel_link(links, platform)
        if not url:
            continue
        num += 1
        label = (item.get("label") or "").strip()
        lines.append(f"{num}.{label}\n{url}" if label else f"{num}.{url}")
    return "\n\n".join(lines)


def apply_nav_items(text: str | None, resolved: list[dict], platform: str) -> str:
    """Подставить собранные пункты на место `{chat_nav_items}`.

    Пунктов не осталось ни одного (ни одной ссылки) → убираем плейсхолдер
    вместе со своей строкой, как принято со всеми пустыми плейсхолдерами.
    """
    txt = text or ""
    if PLACEHOLDER not in txt:
        return txt
    body = render_nav_items(resolved, platform)
    if not body:
        return re.sub(r"^[^\n]*" + re.escape(PLACEHOLDER) + r"[^\n]*\n?", "",
                      txt, flags=re.MULTILINE).strip()
    return txt.replace(PLACEHOLDER, body)
