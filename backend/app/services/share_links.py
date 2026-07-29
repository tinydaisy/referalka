"""
Кросс-платформенные реф-ссылки.

У каждого клиента может быть подключено несколько площадок (Telegram / VK / MAX).
Эта функция возвращает для конкретного события список ссылок — по одной на каждую
**активную** площадку клиента. Использует:
- channels + client_channels — какие платформы у клиента подключены
- features — фича 'channels' определяет VIP (свой бот/сообщество) vs общий (системные каналы)

Применяется в:
- Дашборд: карточка события показывает все ссылки для шеринга клиентом
- Дашборд: страница соорганизатора/спикера — реф-ссылки для каждой платформы
- Mini App: вкладка «Игра» — ссылка только для текущей платформы (откуда открыт)
"""
from __future__ import annotations

from typing import Optional


_PLATFORM_MODE_COL = {
    "telegram": "link_mode_telegram",
    "vk":       "link_mode_vk",
    "max":      "link_mode_max",
}


async def resolve_event_link_mode(db, *, client_id: int, event_link_mode: str | None = None,
                                  platform: str | None = None) -> str:
    """Итоговый режим открытия публичных ссылок события.

    Приоритет:
      1. режим клиента ДЛЯ ЭТОЙ ПЛОЩАДКИ (clients.link_mode_{telegram|vk|max});
      2. общий режим клиента (clients.default_link_mode);
      3. 'bot' (веб-версия).

    ⚠️ Режима У СОБЫТИЯ больше нет (2026-07-28, миграция 240 удалила колонку
    `events.link_mode`). Переключателя для неё в дашборде никогда не было —
    значение проставлялось само при создании события (DEFAULT 'miniapp') и при
    этом было ГЛАВНЕЕ настроек кабинета. Из-за этого переключатель «Веб-версия
    / Mini App» не действовал на уже созданные события: у них навсегда
    оставался зашитый 'miniapp', и в Материалах спикера уезжали ссылки на Mini
    App при настройке «Веб-версия». Единственный источник истины — настройки
    кабинета. Параметр `event_link_mode` оставлен в сигнатуре как no-op, чтобы
    не переписывать вызовы; передавать его больше не нужно.

    ⚠️ Mini App может быть подключён в Telegram и не подключён во ВКонтакте —
    поэтому режим задаётся на каждую площадку отдельно (миграция 200). Без
    `platform` поведение прежнее (общий флаг) — обратная совместимость.

    ⚠️ MAX — ВСЕГДА 'bot' (2026-07-28), настройки клиента игнорируются. В MAX
    нет запроса «разрешить боту писать» (в Telegram это requestWriteAccess, во
    ВКонтакте — разрешение сообщений от сообщества), поэтому человек, зашедший
    через Mini App, на бота НЕ подписывается: рассылки, напоминания и подарки
    до него не дойдут. Веб-ссылка ведёт в бота (`?start=…`) — подписка
    возникает сама. Переключатель «Mini App» для MAX заблокирован и в дашборде
    (mini-app/page.tsx), но форсим и здесь: UI можно обойти, а старые записи
    клиентов могут хранить 'miniapp' с прежних времён.
    """
    if platform == 'max':
        return 'bot'
    if client_id:
        col = _PLATFORM_MODE_COL.get(platform or "")
        cols = f"{col}, default_link_mode" if col else "default_link_mode"
        row = await db.fetchrow(f"SELECT {cols} FROM clients WHERE id = $1", client_id)
        if row:
            if col and row[col] in ('miniapp', 'bot'):
                return row[col]
            if row["default_link_mode"] in ('miniapp', 'bot'):
                return row["default_link_mode"]
    return 'bot'


PLUSON_TG_HANDLE = "pluson_bot"
PLUSON_TG_APP = "pluson"          # short-name Mini App у общего бота
PLUSON_VK_APP_ID = 54592404       # системный VK Mini App ПЛЮСОН (см. memory/vk_prod.md)
PLUSON_VK_HANDLE = "ivision_pluson"  # короткий адрес системного сообщества
PLUSON_MAX_HANDLE = "id890306512862_1_bot"  # системный MAX-бот «ПЛЮСОН-СЕРВИС»


def telegram_link(event_slug: str, *, bot_handle: str | None = None, partner_id: str | None = None, tab: str | None = None, contact_id: Optional[int] = None, link_mode: str = 'miniapp') -> str:
    """Реф-ссылка в Telegram Mini App.

    Если задан contact_id (известный человек) — в payload добавляется `_ct{id}`,
    чтобы при клике на чужой платформе человек привязался к своему контакту,
    а не создал дубль. Если None — поведение как раньше (обратная совместимость).
    """
    # ТОЛЬКО свой бот клиента. Системный @pluson_bot как fallback убран — если у
    # клиента нет своего TG-бота, ссылки в Telegram не строим (пусто).
    handle = (bot_handle or '').lstrip('@')
    if not handle:
        return ''
    parts = [f"ref_pg{event_slug}"]
    if partner_id:
        parts.append(f"pid{partner_id}")
    if tab:
        parts.append(f"tab{tab}")
    if contact_id:
        parts.append(f"ct{contact_id}")
    payload = '_'.join(parts)
    # link_mode='bot' → бот-флоу: t.me/{bot}?start=ref_pg… (бот шлёт воронку события
    # в ЛС). link_mode='miniapp' (дефолт) → открывается Mini App через startapp.
    if link_mode == 'bot':
        return f"https://telegram.me/{handle}?start={payload}"
    # Mini App: у VIP-бота клиента это Main Mini App (без short-name) —
    # `t.me/{handle}?startapp=…`. У общего @pluson_bot приложение привязано
    # отдельным short-name (`/newapp`), поэтому его надо дописывать в путь,
    # иначе ссылка НЕ открывает Mini App (и бот в режиме miniapp молчит).
    app_part = f"/{PLUSON_TG_APP}" if handle.lstrip('@') == PLUSON_TG_HANDLE else ""
    return f"https://telegram.me/{handle}{app_part}?startapp={payload}"


def vk_link(event_slug: str, *, app_id: int | None = None, partner_id: str | None = None, tab: str | None = None, contact_id: Optional[int] = None, link_mode: str = 'miniapp') -> str:
    """Реф-ссылка в VK Mini App. VK передаёт стартовые параметры через hash (#).

    link_mode='bot' → лёгкая заглушка `#evl_{slug}…` (бот шлёт воронку события в ЛС).
    link_mode='miniapp' (дефолт) → полный Mini App `#ref_pg{slug}…`.
    Маркер evl_ парсится в mini-app/src/App.tsx как evl_{slug}[_pid][_src][_ct].
    """
    # ТОЛЬКО свой VK Mini App клиента. Системный VK-app как fallback убран.
    if not app_id:
        return ''
    aid = app_id
    marker = "evl_" if link_mode == 'bot' else "ref_pg"
    parts = [f"{marker}{event_slug}"]
    if partner_id:
        parts.append(f"pid{partner_id}")
    if tab and link_mode != 'bot':
        parts.append(f"tab{tab}")
    if contact_id:
        parts.append(f"ct{contact_id}")
    return f"https://vk.com/app{aid}#{'_'.join(parts)}"


def max_link(event_slug: str, *, bot_handle: str | None = None, partner_id: str | None = None, tab: str | None = None, contact_id: Optional[int] = None, link_mode: str = 'miniapp') -> str:
    """Реф-ссылка в MAX.

    link_mode='bot' → бот-флоу `?start=ref_pg{slug}…` (бот шлёт воронку события в ЛС).
    link_mode='miniapp' (дефолт) → Mini App `?startapp=ref_pg{slug}…`.
    bot_username для системного: id890306512862_1_bot («ПЛЮСОН-СЕРВИС»).
    """
    # ТОЛЬКО свой MAX-бот клиента. Системный MAX-бот как fallback убран.
    handle = (bot_handle or '').lstrip('@')
    if not handle:
        return ''
    parts = [f"ref_pg{event_slug}"]
    if partner_id:
        parts.append(f"pid{partner_id}")
    if tab:
        parts.append(f"tab{tab}")
    if contact_id:
        parts.append(f"ct{contact_id}")
    payload = '_'.join(parts)
    verb = "start" if link_mode == 'bot' else "startapp"
    return f"https://max.ru/{handle}?{verb}={payload}"


async def get_active_platforms(db, client_id: int) -> list[str]:
    """Возвращает список платформ ['telegram', 'vk', 'max'] которые активны у клиента.

    Активны = у клиента есть СВОЙ (не системный) активный канал на этой платформе
    (через client_channels.is_active + channels.is_system=FALSE).
    Используется на фронте чтобы понять какие реф-ссылки показывать.

    ⚠️ Системные каналы (@pluson_bot и т.п.) НЕ учитываются — ссылка на площадку
    показывается клиенту только если он подключил собственный канал.
    """
    rows = await db.fetch(
        """SELECT DISTINCT ch.platform_slug
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE
              AND ch.is_system = FALSE""",
        client_id,
    )
    return [r["platform_slug"] for r in rows]


async def get_client_bot_handles(db, client_id: int) -> dict[str, str | None]:
    """Возвращает словарь {platform → handle_клиентского_канала}.

    Если у клиента нет своего канала на платформе — значение None, что означает
    «используется системный канал» (на TG = @pluson_bot, на VK = системное сообщество).
    """
    result: dict[str, str | None] = {"telegram": None, "vk": None, "max": None}
    rows = await db.fetch(
        """SELECT ch.platform_slug, ch.handle, ch.is_system
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE
              AND ch.is_system = FALSE""",
        client_id,
    )
    for r in rows:
        result[r["platform_slug"]] = (r["handle"] or "").lstrip('@') or None
    return result


def build_event_signup_links(handles: dict[str, str | None], event_slug: str) -> dict[str, str]:
    """Ссылки «Зарегистрироваться» по площадкам: клик → бот присылает сообщение
    события с кнопкой регистрации (тот же вход, что в «Публичных ссылках»).

    ⚠️ Формат — `ref_pg{slug}`, а НЕ `evsignup_{id}`: последний существует
    только как callback УЖЕ НАЖАТОЙ кнопки внутри бота, обработчика команды
    /start с таким аргументом в Telegram нет вовсе. Ссылка с ним вела в бота,
    где ничего не происходило.
      • TG:  telegram.me/{handle}?start=ref_pg{slug}
      • VK:  vk.me/{handle}?ref=ref_pg{slug}
      • MAX: max.ru/{handle}?start=ref_pg{slug}
    Нет своего бота на площадке → пустая строка (системный бот не используется).
    """
    tg = (handles.get("telegram") or "").lstrip('@')
    vk = (handles.get("vk") or "").lstrip('@')
    mx = (handles.get("max") or "").lstrip('@')
    payload = f"ref_pg{event_slug}"
    return {
        "telegram": f"https://telegram.me/{tg}?start={payload}" if tg else "",
        "vk": f"https://vk.me/{vk}?ref={payload}" if vk else "",
        "max": f"https://max.ru/{mx}?start={payload}" if mx else "",
    }


# Приоритет подмены, когда на площадке получателя ссылки нет (бота нет или
# площадка выключена в настройках события). Своя площадка — первой, дальше
# по убыванию близости. Тот же порядок, что у ссылок подарков на фронте.
SIGNUP_FALLBACK_ORDER = {
    "telegram": ("telegram", "max", "vk"),
    "vk": ("vk", "max", "telegram"),
    "max": ("max", "vk", "telegram"),
    "email": ("telegram", "max", "vk"),
}


def pick_signup_link(links: dict[str, str], platform: str, web_url: str = "") -> str:
    """Ссылка регистрации для получателя НА ЕГО площадке.

    Нет своей → берём соседнюю по SIGNUP_FALLBACK_ORDER (например из ВК уводим
    в MAX). Совсем ничего нет → веб-страница регистрации (web_url).
    """
    for p in SIGNUP_FALLBACK_ORDER.get(platform, SIGNUP_FALLBACK_ORDER["telegram"]):
        if links.get(p):
            return links[p]
    return web_url


def build_support_command_links(handles: dict[str, str | None], event_id: int) -> dict[str, str]:
    """Deeplink-ссылки «Тех.поддержка» по площадкам: клик → бот вызывает команду
    support (сообщение со всеми каналами связи клиента-владельца события).
    Формат — тот же deeplink-паттерн, что evlive_/evchat_:
      • TG:  telegram.me/{handle}?start=evsupport_{event_id}
      • VK:  vk.me/{handle}?ref=evsupport_{event_id}
      • MAX: max.ru/{handle}?start=evsupport_{event_id}
    Нет своего бота на площадке (handle=None) → пустая строка (ссылка не строится,
    системный бот не используется — как и во всех share-ссылках проекта)."""
    tg = (handles.get("telegram") or "").lstrip('@')
    vk = (handles.get("vk") or "").lstrip('@')
    mx = (handles.get("max") or "").lstrip('@')
    return {
        "telegram": f"https://telegram.me/{tg}?start=evsupport_{event_id}" if tg else "",
        "vk": f"https://vk.me/{vk}?ref=evsupport_{event_id}" if vk else "",
        "max": f"https://max.ru/{mx}?start=evsupport_{event_id}" if mx else "",
    }


async def get_client_vk_app_id(db, client_id: int) -> Optional[int]:
    """Возвращает VK App ID клиентского Mini App (из channels.platform_meta).
    Если клиент не подключил своё сообщество — None (фронт/бэк должны
    своего VK Mini App нет → ссылка не строится (системный VK-app не используется).
    """
    val = await db.fetchval(
        """SELECT (ch.platform_meta->>'vk_app_id')::int
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk'
              AND ch.is_system = FALSE
              AND ch.platform_meta->>'vk_app_id' IS NOT NULL
            LIMIT 1""",
        client_id,
    )
    return int(val) if val else None


async def _has_system_channel(db, platform_slug: str, *, allow_test: bool = True) -> bool:
    """Есть ли системный канал на платформе. allow_test=True учитывает is_test каналы
    (для отображения «скоро» в UI), False — только полностью активированные."""
    if allow_test:
        return bool(await db.fetchval(
            "SELECT 1 FROM channels WHERE platform_slug = $1 AND is_system = TRUE LIMIT 1",
            platform_slug,
        ))
    return bool(await db.fetchval(
        "SELECT 1 FROM channels WHERE platform_slug = $1 AND is_system = TRUE AND is_test = FALSE LIMIT 1",
        platform_slug,
    ))


async def build_share_links(
    db,
    *,
    client_id: int,
    event_slug: str,
    partner_id: Optional[str] = None,
    tab: Optional[str] = None,
    contact_id: Optional[int] = None,
    link_mode: str = 'miniapp',
) -> dict[str, str]:
    """Возвращает {platform → url} ТОЛЬКО для тех платформ, где у клиента
    подключён СВОЙ канал (channels.is_system=FALSE).

    Логика:
    - Если у клиента подключён свой бот/сообщество на платформе → ссылка на его handle
    - Иначе ссылка НЕ возвращается (системные каналы ПЛЮСОНа больше не используются —
      ни для показа, ни для шеринга).
    """
    handles = await get_client_bot_handles(db, client_id)
    vk_app_id = await get_client_vk_app_id(db, client_id)

    # Режим открытия — СВОЙ на каждую площадку (миграция 200): Mini App может быть
    # подключён в TG и отсутствовать в VK. Колонка площадки перекрывает общий режим;
    # если она пуста — остаётся `link_mode`, который передал вызывающий код.
    per = await db.fetchrow(
        "SELECT link_mode_telegram, link_mode_vk, link_mode_max FROM clients WHERE id = $1",
        client_id,
    ) if client_id else None

    def _mode(col: str) -> str:
        # MAX — всегда веб-версия (в Mini App человек не подписывается на бота,
        # см. resolve_event_link_mode). Настройки клиента для max игнорируем.
        if col == "link_mode_max":
            return 'bot'
        v = per[col] if per else None
        return v if v in ('miniapp', 'bot') else link_mode

    result: dict[str, str] = {}
    if handles.get("telegram"):
        result["telegram"] = telegram_link(event_slug, bot_handle=handles["telegram"], partner_id=partner_id, tab=tab, contact_id=contact_id, link_mode=_mode("link_mode_telegram"))
    if handles.get("vk") and vk_app_id:
        result["vk"] = vk_link(event_slug, app_id=vk_app_id, partner_id=partner_id, tab=tab, contact_id=contact_id, link_mode=_mode("link_mode_vk"))
    if handles.get("max"):
        result["max"] = max_link(event_slug, bot_handle=handles["max"], partner_id=partner_id, tab=tab, contact_id=contact_id, link_mode=_mode("link_mode_max"))

    # Площадки, отключённые у ЭТОГО события (миграция 263): ссылку наружу не
    # отдаём — ни спикерам в кабинет/материалы, ни участникам в реф-ссылки.
    # ⚠️ Сам бот площадки продолжает работать: прячем только публичную выдачу.
    for p in await get_event_disabled_platforms(db, event_slug=event_slug):
        result.pop(p, None)
    return result


async def get_event_disabled_platforms(db, *, event_slug: str = "",
                                       event_id: Optional[int] = None) -> set[str]:
    """Площадки, выключенные галочкой в «Публичных ссылках» события (миграция 263)."""
    if event_id:
        row = await db.fetchrow("SELECT disabled_platforms FROM events WHERE id = $1", event_id)
    elif event_slug:
        row = await db.fetchrow("SELECT disabled_platforms FROM events WHERE slug = $1", event_slug)
    else:
        return set()
    return {p for p in (row["disabled_platforms"] or [])} if row else set()


async def build_funnel_landing_links(
    db,
    *,
    client_id: int,
    slug: str,
    kind: str = "m",
    base_url: str = "https://pluson.ru",
) -> dict[str, str]:
    """Возвращает {platform → deeplink} для landing воронки лид-магнита/пакета.

    Прямые ссылки в чат с ботом/сообществом — без промежутка через pluson.ru.
    Бот / Mini App сами парсят `m_{slug}` или `p_{slug}` в start-параметре/hash
    и создают funnel_run + запускают воронку.

    Форматы:
    - TG: `t.me/{bot_handle}?start={kind}_{slug}` (только свой бот клиента)
    - VK: `vk.com/app{vk_app_id}#{kind}_{slug}` (только Mini App клиента)
    - MAX: `max.ru/{handle}?start={kind}_{slug}` (только свой MAX-бот клиента)

    ⚠️ Ссылка на площадку возвращается ТОЛЬКО если у клиента подключён
    собственный канал на этой платформе. Системные каналы ПЛЮСОНа
    (@pluson_bot и т.п.) больше не используются как fallback.
    """
    if kind not in ("m", "p"):
        raise ValueError(f"kind must be 'm' or 'p', got {kind!r}")
    payload = f"{kind}_{slug}"
    handles = await get_client_bot_handles(db, client_id)
    result: dict[str, str] = {}

    # TG: только свой бот клиента
    if handles.get("telegram"):
        result["telegram"] = f"https://telegram.me/{handles['telegram'].lstrip('@')}?start={payload}"

    # VK: только собственное сообщество клиента (его vk_app_id)
    if handles.get("vk"):
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            result["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"

    # MAX: только собственный MAX-бот клиента
    if handles.get("max"):
        result["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?start={payload}"

    return result


# ── Токены ссылок воронки подарков-лид-магнитов ⟦GF:m|p:slug⟧ ────────────────
# Подарок-лид-магнит/пакет ПЛЮСОНа в тексте рассылки помечается токеном
# ⟦GF:kind:slug⟧ (kind = m — лид-магнит, p — пакет). Прямой файл в рассылку НЕ
# уходит: он выдаётся воронкой за подписку. Токен раскрывается ПЛАТФОРМЕННОЙ
# ссылкой на воронку через VIP-бот клиента, с приоритетом по площадке получателя.
import re as _re

GIFT_FUNNEL_TOKEN_RE = _re.compile(r"⟦GF:([mp]):([^⟧]+)⟧")

# Приоритет выбора площадки ссылки в зависимости от площадки рассылки:
#   MAX-рассылка → max > vk > telegram
#   VK-рассылка  → vk > max > telegram
#   TG/email     → telegram > max > vk
GIFT_FUNNEL_PLATFORM_PRIORITY: dict[str, tuple[str, ...]] = {
    "telegram": ("telegram", "max", "vk"),
    "max": ("max", "vk", "telegram"),
    "vk": ("vk", "max", "telegram"),
    "email": ("telegram", "max", "vk"),
}


def pick_gift_funnel_link(links: dict, platform: str) -> str:
    """Выбрать ссылку воронки для площадки по приоритету с фолбэком.

    links — {'telegram'|'vk'|'max' → url}, как отдаёт build_funnel_landing_links
    (только те площадки, где у клиента подключён свой бот/сообщество).
    Нет ни одной → '' (ссылка не строится)."""
    for _p in GIFT_FUNNEL_PLATFORM_PRIORITY.get(platform, GIFT_FUNNEL_PLATFORM_PRIORITY["telegram"]):
        if links.get(_p):
            return links[_p]
    return ""


async def gift_funnel_owner_id(db, kind: str, slug: str) -> int | None:
    """client_id ХОЗЯИНА лид-магнита/пакета по его slug.

    ⚠️ Ключевое правило подарков: воронка живёт в базе ХОЗЯИНА магнита (спикера),
    поэтому ссылка обязана вести в ЕГО бот — а не в бот клиента, который шлёт
    рассылку. Иначе человек придёт в чужой бот, где этой воронки нет, и подарок
    не выдастся.

    kind: 'p' — пакет (lead_magnet_packages), 'm' — лид-магнит (lead_magnets).
    """
    if kind == "p":
        return await db.fetchval("SELECT client_id FROM lead_magnet_packages WHERE slug=$1", slug)
    return await db.fetchval("SELECT client_id FROM lead_magnets WHERE slug=$1", slug)


async def build_gift_funnel_links_by_owner(db, kind: str, slug: str) -> dict[str, str]:
    """{площадка → ссылка} на воронку подарка, построенная по каналам ХОЗЯИНА магнита.

    Площадку выбирает ОТПРАВИТЕЛЬ рассылки (см. pick_gift_funnel_link), но бот
    внутри площадки — всегда хозяина. Хозяин не найден / нет его каналов → {}.
    """
    owner = await gift_funnel_owner_id(db, kind, slug)
    if not owner:
        return {}
    try:
        return await build_funnel_landing_links(db, client_id=owner, slug=slug, kind=kind)
    except Exception:
        return {}


async def resolve_gift_funnel_tokens(db, *, client_id: int, text: str | None, platform: str) -> str:
    """Заменить в тексте все токены ⟦GF:kind:slug⟧ ссылкой на воронку нужной
    площадки. Разовое использование (превью/тест-отправка). В боевой рассылке
    ссылки кэшируются на всю аудиторию — там своя inline-версия.

    ⚠️ client_id (отправитель рассылки) тут НЕ используется для построения ссылки —
    бот берётся у ХОЗЯИНА магнита по slug. Параметр оставлен для совместимости
    вызовов; площадка приходит отдельно (её диктует отправитель).
    """
    if not text or "⟦GF:" not in text:
        return text or ""
    cache: dict[tuple[str, str], dict] = {}

    async def _links(kind: str, slug: str) -> dict:
        key = (kind, slug)
        if key not in cache:
            cache[key] = await build_gift_funnel_links_by_owner(db, kind, slug)
        return cache[key]

    # Собираем уникальные (kind, slug), резолвим ссылки, затем подставляем.
    for m in set((mm.group(1), mm.group(2)) for mm in GIFT_FUNNEL_TOKEN_RE.finditer(text)):
        await _links(m[0], m[1])

    def _sub(m):
        return pick_gift_funnel_link(cache.get((m.group(1), m.group(2))) or {}, platform)

    return GIFT_FUNNEL_TOKEN_RE.sub(_sub, text)


async def build_invite_links_for_collaborator(
    db,
    client_id: int,
    access_code: str,
    event_id: int | None = None,
) -> dict[str, str]:
    """Возвращает {platform → deeplink} для invite-ссылок самообслуживания спикера.

    Спикер кликает любую из этих ссылок → попадает в личку нашего бота на
    соответствующей платформе → бот ловит `spkinv_<access_code>` → шлёт код
    доступа и ссылку на лендинг pluson.ru/speaker/<event_slug>.

    Если передан `event_id`, он зашивается в payload как `spkinv_<code>_e<id>` —
    бот откроет кабинет ИМЕННО этого события (а не «последнего по ec.id»,
    которое могло переехать на копию-черновик). Старые ссылки без `_e<id>`
    продолжают работать по прежней логике (последнее событие коллаба).

    Бот выбирается так же, как для лид-магнитов:
      - TG: VIP-бот клиента ИЛИ системный @pluson_bot.
      - VK / MAX: только собственный канал клиента (системные принадлежат
        ПЛЮСОНу и не пишут в личку подписчикам чужих клиентов).
    """
    payload = f"spkinv_{access_code}"
    if event_id:
        payload = f"{payload}_e{int(event_id)}"
    handles = await get_client_bot_handles(db, client_id)
    result: dict[str, str] = {}

    # TG: только свой бот клиента (системный @pluson_bot больше не fallback)
    if handles.get("telegram"):
        result["telegram"] = f"https://telegram.me/{handles['telegram'].lstrip('@')}?start={payload}"

    # VK: используем Mini App клиента (как лид-магниты) — `vk.com/app{vk_app_id}#spkinv_<code>`.
    # Mini App при загрузке парсит hash и шлёт POST /api/v1/vk/speaker-invite — бэк сам
    # создаёт platform_user и шлёт сообщение в личку через сообщество. Это надёжнее, чем
    # vk.me/group?ref=..., который требует чтобы пользователь сам написал сообщение боту.
    if handles.get("vk"):
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            result["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"

    if handles.get("max"):
        result["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?start={payload}"

    return result


async def build_speaker_self_register_links(
    db,
    client_id: int,
    event_id: int,
) -> dict[str, str]:
    """Прямые ссылки для саморегистрации спикером события (2026-05-29).

    Клиент шарит эти ссылки тем, кто хочет выступить. Пользователь
    переходит → попадает в бот → нажимает «Включить в спикеры» (TG,
    callback) или сразу регистрируется (VK/MAX, по ref).

    Бот / сообщество выбирается как для invite-ссылок:
      - TG: VIP-бот клиента ИЛИ системный @pluson_bot
      - VK: только собственное сообщество клиента (vk.me/{group}?ref=…)
      - MAX: только собственный MAX-бот клиента
    """
    payload = f"spkreg_{event_id}"
    handles = await get_client_bot_handles(db, client_id)
    result: dict[str, str] = {}

    # TG: только свой бот клиента (системный @pluson_bot больше не fallback)
    if handles.get("telegram"):
        result["telegram"] = f"https://telegram.me/{handles['telegram'].lstrip('@')}?start={payload}"

    # VK: через Mini App клиента (как spkinv_). vk.me/{handle}?ref=
    # ненадёжен — VK не передаёт ref если пользователь раньше уже писал
    # сообществу. Mini App парсит hash и шлёт POST /api/v1/vk/speaker-self-register.
    if handles.get("vk"):
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            result["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"

    if handles.get("max"):
        result["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?startapp={payload}"

    return result


async def build_speaker_self_edit_links(
    db,
    client_id: int,
    event_id: int,
) -> dict[str, str]:
    """Прямые ссылки для входа в кабинет уже-добавленного спикера (и его
    ассистента). В отличие от build_speaker_self_register_links, эта ссылка
    НЕ создаёт нового коллаба — только пускает в кабинет.

    payload = spkedit_<event_id>. Бот по TG зашедшего находит спикера события
    (личный TG или assistant_tg_username) → отдаёт его код доступа.
    """
    payload = f"spkedit_{event_id}"
    handles = await get_client_bot_handles(db, client_id)
    result: dict[str, str] = {}

    # TG: только свой бот клиента (системный @pluson_bot больше не fallback)
    if handles.get("telegram"):
        result["telegram"] = f"https://telegram.me/{handles['telegram'].lstrip('@')}?start={payload}"

    if handles.get("vk"):
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            result["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"

    if handles.get("max"):
        result["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?startapp={payload}"

    return result


async def build_event_chat_bot_links(
    db,
    client_id: int,
    event_id: int,
) -> dict[str, str]:
    """Deeplink'и в бот площадки на «вступить в чат события» (проверка подписки
    на каналы спикеров/организаторов → выдача ссылок на чаты).

    Используется кнопкой «Чат события» на веб-странице /event/{slug}, когда у
    события включена обязательная подписка: человек нажимает площадку → попадает
    в бот ИМЕННО этой площадки на кусок воронки «вступить в чат».

      - TG:  t.me/{bot}?start=evchat_<event_id>   (VIP-бот клиента или @pluson_bot)
      - VK:  vk.me/{group}?ref=evchat_<event_id>  (только своё сообщество клиента)
      - MAX: max.ru/{handle}?start=evchat_<event_id>  (только свой MAX-бот клиента)

    На площадке без собственного канала клиента (VK/MAX) ссылку не возвращаем —
    системные каналы ПЛЮСОНа в личку чужим подписчикам не пишут.
    """
    payload = f"evchat_{event_id}"
    handles = await get_client_bot_handles(db, client_id)
    result: dict[str, str] = {}

    # TG: только свой бот клиента (системный @pluson_bot больше не fallback)
    if handles.get("telegram"):
        result["telegram"] = f"https://telegram.me/{handles['telegram'].lstrip('@')}?start={payload}"

    if handles.get("vk"):
        result["vk"] = f"https://vk.me/{handles['vk'].lstrip('@')}?ref={payload}"

    if handles.get("max"):
        result["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?start={payload}"

    return result


# ─────────────────── Проверка: подключён ли у бота Mini App ───────────────────

async def telegram_mini_app_status(db, client_id: int) -> dict:
    """Есть ли у активного TG-бота клиента подключённое Mini App.

    Telegram отдаёт это двумя способами:
      • `getMe` → `has_main_web_app` — привязан Main Mini App (`?startapp=`);
      • `getChatMenuButton` → `type='web_app'` — кнопка меню открывает приложение.

    Общий @pluson_bot — особый случай: приложение привязано отдельным short-name
    (`/newapp`), поэтому `has_main_web_app` может быть FALSE, а ссылка
    `t.me/pluson_bot/pluson?startapp=…` при этом работает.

    Возвращает {has_bot, has_mini_app, bot_handle, reason}.
    Сетевая ошибка → has_mini_app=None (не знаем — не блокируем клиента).
    """
    import httpx

    row = await db.fetchrow(
        """SELECT ch.handle, ch.bot_token
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1 AND ch.platform_slug = 'telegram'
              AND cc.is_active = TRUE AND ch.bot_token IS NOT NULL
            LIMIT 1""",
        client_id,
    )
    if not row or not row["bot_token"]:
        return {"has_bot": False, "has_mini_app": False, "bot_handle": None,
                "reason": "У вас не подключён Telegram-бот."}

    handle = (row["handle"] or "").lstrip("@")
    if handle == PLUSON_TG_HANDLE:
        # Mini App общего бота живёт под short-name — считаем, что он есть.
        return {"has_bot": True, "has_mini_app": True, "bot_handle": handle, "reason": ""}

    try:
        async with httpx.AsyncClient(timeout=6) as http:
            me = (await http.get(f"https://api.telegram.org/bot{row['bot_token']}/getMe")).json()
            mb = (await http.get(f"https://api.telegram.org/bot{row['bot_token']}/getChatMenuButton")).json()
    except Exception:  # noqa: BLE001
        return {"has_bot": True, "has_mini_app": None, "bot_handle": handle,
                "reason": "Не удалось проверить — Telegram не ответил."}

    has_main = bool((me.get("result") or {}).get("has_main_web_app"))
    menu_is_app = ((mb.get("result") or {}).get("type") == "web_app")
    ok = has_main or menu_is_app
    return {
        "has_bot": True,
        "has_mini_app": ok,
        "bot_handle": handle,
        "reason": "" if ok else (
            f"У бота @{handle} не подключено Mini App. Откройте @BotFather → /newapp "
            "и привяжите приложение — либо выберите режим «Веб-версия»."
        ),
    }
