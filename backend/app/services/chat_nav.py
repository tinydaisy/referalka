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
    cabinet  — «Кабинет, Программа, Спикеры»: МЕНЮ события в боте площадки
    gifts    — «Подарки за регистрацию и рекомендации»: `/podarki{id}` в боте
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


async def resolve_for_schedule(db, schedule, event_id: int) -> list[dict]:
    """Пункты навигации для КОНКРЕТНОЙ рассылки — ЕДИНАЯ точка.

    ⚠️⚠️ Зовут ОБА пути: боевая отправка (Celery), превью и тест. Раньше у
    каждого был свой кусок логики, и они разошлись на первом же отличии:
    `broadcast_schedules.client_id` бывает NULL, боевая ветка берёт владельца
    события запросом, а тест читал поле как есть — и молча слал сообщение
    с одним заголовком, без единой ссылки (21.09.2026, прод).

    Новое отличие между тестом и боем правится ЗДЕСЬ, а не копированием.
    """
    items = parse_items(
        schedule.get("nav_items") if hasattr(schedule, "get") else None)
    # Снимка нет (рассылку поставили в очередь до того, как появились пункты)
    # — берём актуальные из шаблона, как и текст.
    if not items and schedule.get("template_id"):
        items = parse_items(await db.fetchval(
            "SELECT nav_items FROM broadcast_templates WHERE id = $1",
            schedule["template_id"]))
    if not items or not event_id:
        return []
    client_id = schedule.get("client_id") or await db.fetchval(
        """SELECT eo.client_id FROM event_owners eo
            WHERE eo.event_id = $1 AND eo.status = 'accepted'
            ORDER BY (eo.role = 'owner') DESC, eo.id LIMIT 1""", event_id)
    if not client_id:
        return []
    return await resolve_nav_links(db, items=items, event_id=event_id, client_id=client_id)


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
    gifts_links: Optional[dict] = None

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
            # ⚠️ ВК — через Mini App (`#nav_support{id}`): контакты поддержки
            # приходят в ЛС сами. Ссылка `vk.me/...?ref=evsupport_` не работала
            # у тех, кто уже писал сообществу — ВК метку не передаёт (см.
            # пояснение в `_build_gifts_links`).
            from app.services.share_links import get_client_vk_app_id as _vk_app
            _aid = await _vk_app(db, client_id)
            if _aid:
                links["vk"] = f"https://vk.com/app{_aid}#nav_support{event_id}"
            else:
                links.pop("vk", None)

        elif kind == "cabinet":
            if cabinet_links is None:
                cabinet_links = await _build_cabinet_links(db, event_id, client_id)
            links = dict(cabinet_links)

        elif kind == "gifts":
            # ⚠️ Подарки — ОТДЕЛЬНЫЙ пункт от «Кабинет, Программа, Спикеры»
            # (решение владельца 22.09.2026). Раньше один пункт `cabinet` вёл
            # и туда, и туда, а это разные намерения: «хочу подарки за
            # рекомендации» и «хочу посмотреть программу». Ведём командой
            # `/podarki{event_id}` в бота той площадки, где человек читает чат.
            if gifts_links is None:
                gifts_links = await _build_gifts_links(db, event_id, client_id)
            links = dict(gifts_links)

        elif kind == "magnet":
            slug = (item.get("magnet_slug") or "").strip()
            mkind = (item.get("magnet_kind") or "m").strip()
            if slug:
                links = {k: v for k, v in
                         (await build_gift_funnel_links_by_owner(db, mkind, slug)).items() if v}
                # ⚠️ ВК-ссылка магнита (`vk.com/app{aid}#m_<slug>`) остаётся как
                # есть: Mini App разбирает маркер и сам просит сервер выслать
                # воронку в ЛС — тот же механизм, на который 22.09.2026
                # переведены подарки, меню и поддержка (`#nav_*`).
                # ⚠️ Жалоба «ссылка на лид-магнит открывает мини-апп события»
                # была следствием ДРУГОГО: у пунктов навигации ВК ссылки вели в
                # диалог с меткой `?ref=`, которую ВК не передаёт писавшим
                # ранее, и человек оставался в приложении без воронки.

        if label or links:
            # ⚠️ `own_only` — ссылка имеет смысл ТОЛЬКО на своей площадке.
            # Правила нетворкинга лежат в закрепе КОНКРЕТНОГО чата: выдать
            # человеку в ВК ссылку «Через Телеграм: …» значит отправить его в
            # чат, где его нет. Лучше не показать пункт вовсе.
            out.append({"label": label, "links": links, "own_only": kind == "rules"})

    return out


async def _build_gifts_links(db, event_id: int, client_id: int) -> dict[str, str]:
    """Ссылки на ПОДАРКИ за регистрацию и рекомендации — команда `/podarki{id}`.

    Отдельный пункт навигации от «Кабинет, Программа, Спикеры» (решение
    владельца 22.09.2026): это разные намерения, и вести их одной ссылкой
    значит заставлять человека искать нужное уже внутри.

    Ведём в БОТА той площадки, где человек читает чат — как и `cabinet`:
    бот ответит личными реф-ссылками, лестницей подарков и кнопкой в кабинет.
    Ссылка — deeplink `?start=podarki{event_id}`, бот разбирает его тем же
    обработчиком, что и команду `/podarki{event_id}`, набранную руками.

    ⚠️ ВКонтакте: у бота нет deeplink со стартовым payload, как в TG/MAX, —
    человека туда ведём на диалог с сообществом, а слово `podarki{id}` он
    напишет сам (обработчик в `vk_main.py` его ловит). Дать вместо этого
    Mini App-ссылку нельзя: подарки отдаёт именно бот.
    """
    from app.services.share_links import (
        get_client_bot_handles, get_client_vk_app_id, get_event_disabled_platforms,
    )

    row = await db.fetchrow("SELECT slug FROM events WHERE id = $1", event_id)
    if not row:
        return {}

    handles = await get_client_bot_handles(db, client_id)
    disabled = await get_event_disabled_platforms(db, event_slug=(row["slug"] or ""))
    links: dict[str, str] = {}
    payload = f"podarki{event_id}"

    if "telegram" not in disabled and handles.get("telegram"):
        h = (handles["telegram"] or "").lstrip("@")
        if h:
            links["telegram"] = f"https://t.me/{h}?start={payload}"

    if "max" not in disabled and handles.get("max"):
        h = (handles["max"] or "").lstrip("@")
        if h:
            links["max"] = f"https://max.ru/{h}?start={payload}"

    # ⚠️⚠️ ВК — ЧЕРЕЗ MINI APP, сообщение уходит САМО (22.09.2026, решение
    # владельца: «чтобы при переходе по ссылке в боте отправлялись нужные
    # сообщения»).
    #
    # Ссылкой в диалог это недостижимо: метку `?ref=` ВК передаёт ТОЛЬКО тем,
    # кто ещё ни разу не писал сообществу (у остальных приходит пусто — отсюда
    # жалоба «ничего не приходит»), а `?text=` лишь кладёт команду в поле
    # ввода, и человеку надо нажать «отправить» самому.
    #
    # `vk.com/app{aid}#nav_gifts{id}` открывает Mini App клиента, тот просит
    # разрешение на ЛС и зовёт `/api/v1/vk/nav-action` — сервер отправляет
    # человеку подарки в личные сообщения. Ровно тот же механизм, что у
    # лид-магнитов (`m_<slug>`), он работает давно.
    if "vk" not in disabled:
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            links["vk"] = f"https://vk.com/app{vk_app_id}#nav_gifts{event_id}"

    return links


async def _build_cabinet_links(db, event_id: int, client_id: int) -> dict[str, str]:
    """Ссылки «Кабинет, Программа, Спикеры» — на МЕНЮ СОБЫТИЯ в боте.

    ⚠️ Раньше пункт вёл сразу на вкладку подарков (`tab=game`), и он же был
    единственным «кабинетным» пунктом. С 22.09.2026 подарки вынесены в
    отдельный пункт (`kind='gifts'`, `_build_gifts_links`), а этот ведёт на
    МЕНЮ события — оттуда человек попадает и в кабинет, и в программу, и к
    спикерам. Вести пункт с названием «Кабинет, Программа, Спикеры» прямо на
    подарки значило бы обещать одно, а открывать другое.

    ⚠️⚠️ **ИЗ ЧАТА ВЕДЁМ В БОТА НА ВСЕХ ТРЁХ ПЛОЩАДКАХ** (решение владельца
    22.09.2026), то есть `link_mode='bot'` принудительно, а не по настройке
    клиента. Бот показывает МЕНЮ СОБЫТИЯ, а уже кнопка в меню открывает вкладку
    подарков — Mini App или веб-версией, как настроено. Раньше Telegram брал
    режим клиента, получал `miniapp` и отдавал `?startapp=…_tabgame`; Mini App
    же ДО всякой проверки регистрации спрашивает `/landing-redirect`, а тот при
    `registration_mode='landing'` возвращает лендинг, не глядя, зарегистрирован
    человек или нет. В итоге участник события 89 (ivision9) жал «Подарки» в
    чате и попадал на форму регистрации, хотя давно зарегистрирован. В MAX
    этого не было ровно потому, что там всегда бот: он первым делом смотрит
    `is_registered` и шлёт меню.

    ⚠️ Бот ещё и надёжнее опознаёт человека: в чате `contact_id` подставить
    нельзя (чат — не личка), а боту человек пишет лично, и тот резолвит его по
    своему `user_id`. Mini App в этом месте опирался на `tg_id` из initData, и
    у кого TG-идентичности не было (регистрировался через MAX или веб),
    проверка регистрации не находила ничего и тоже уводила на лендинг.

    ⚠️ Человек в чате не опознан (чат — не личка), поэтому ни `pid`, ни
    `contact_id` не подставляем: персональной метки у чата быть не может.
    Не зарегистрирован — бот сам предложит регистрацию.
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

    # ⚠️ `link_mode='bot'` жёстко, без `resolve_event_link_mode`: ссылка из ЧАТА
    # обязана привести в бота, к меню события (см. докстринг). Настройка клиента
    # «Mini App или веб» никуда не делась — она решает, чем бот откроет разделы
    # по кнопкам меню, и применяется уже там (`send_event_menu`).
    # ⚠️ `tab` НЕ передаём: пункт ведёт на МЕНЮ, а не в конкретную вкладку.
    # Подарки — отдельный пункт `gifts` (`_build_gifts_links`).
    if "telegram" not in disabled and handles.get("telegram"):
        url = telegram_link(slug, bot_handle=handles["telegram"],
                            link_mode="bot", client_id=client_id)
        if url:
            links["telegram"] = url

    # ⚠️ ВК ведём В ДИАЛОГ СООБЩЕСТВА с меткой `ref=menu{event_id}` (22.09.2026).
    # `vk_link` в ЛЮБОМ режиме отдаёт ссылку на Mini App (`vk.com/app…`) —
    # меняется только маркер внутри hash. То есть пункт «Кабинет, Программа,
    # Спикеры» в ВК открывал Mini App, а не меню события в боте, хотя в TG и
    # MAX открывал именно меню. Метку `menu{id}` ВК-бот уже понимает
    # (`_extract_event_trigger_id` ловит «ивент|event|menu» + номер).
    # ⚠️ ВК — через Mini App (`#nav_menu{id}`): сообщение с меню события
    # приходит само, см. пояснение в `_build_gifts_links`.
    if "vk" not in disabled:
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            links["vk"] = f"https://vk.com/app{vk_app_id}#nav_menu{event_id}"

    if "max" not in disabled and handles.get("max"):
        url = max_link(slug, bot_handle=handles["max"], link_mode="bot")
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
