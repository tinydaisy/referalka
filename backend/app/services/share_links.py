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
    handle = (bot_handle or PLUSON_TG_HANDLE).lstrip('@')
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
        return f"https://t.me/{handle}?start={payload}"
    # У общего @pluson_bot Mini App имеет short-name `pluson` (one 's')
    # У VIP-бота Main Mini App без short-name — `t.me/{handle}?startapp=…`
    app_part = f"/{PLUSON_TG_APP}" if handle == PLUSON_TG_HANDLE else ""
    return f"https://t.me/{handle}{app_part}?startapp={payload}"


def vk_link(event_slug: str, *, app_id: int | None = None, partner_id: str | None = None, tab: str | None = None, contact_id: Optional[int] = None, link_mode: str = 'miniapp') -> str:
    """Реф-ссылка в VK Mini App. VK передаёт стартовые параметры через hash (#).

    link_mode='bot' → лёгкая заглушка `#evl_{slug}…` (бот шлёт воронку события в ЛС).
    link_mode='miniapp' (дефолт) → полный Mini App `#ref_pg{slug}…`.
    Маркер evl_ парсится в mini-app/src/App.tsx как evl_{slug}[_pid][_src][_ct].
    """
    aid = app_id or PLUSON_VK_APP_ID
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
    handle = (bot_handle or PLUSON_MAX_HANDLE).lstrip('@')
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

    Активны = у клиента есть активный канал на этой платформе (через client_channels.is_active).
    Используется на фронте чтобы понять какие реф-ссылки показывать.
    """
    rows = await db.fetch(
        """SELECT DISTINCT ch.platform_slug
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE""",
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


async def get_client_vk_app_id(db, client_id: int) -> Optional[int]:
    """Возвращает VK App ID клиентского Mini App (из channels.platform_meta).
    Если клиент не подключил своё сообщество — None (фронт/бэк должны
    зафолбэчиться на системный PLUSON_VK_APP_ID).
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
    """Возвращает {platform → url} для всех **активных** платформ клиента + системных.

    Логика:
    - Если у клиента подключен свой бот на платформе → его handle
    - Иначе если есть системный канал ПЛЮСОН на этой платформе → системный bot/app
    - Платформа добавляется в результат если ИЛИ клиент имеет канал ИЛИ есть системный
    """
    platforms = set(await get_active_platforms(db, client_id))
    handles = await get_client_bot_handles(db, client_id)
    vk_app_id = await get_client_vk_app_id(db, client_id)
    # Системный канал засчитываем только если ОН ВЫВЕДЕН клиентам (is_test=FALSE).
    # Каналы в test-режиме настраиваются админом и не должны светиться у клиентов
    # в виде публичных ссылок (даже на превью).
    for ps in ("telegram", "vk", "max"):
        if await _has_system_channel(db, ps, allow_test=False):
            platforms.add(ps)
    result: dict[str, str] = {}
    if "telegram" in platforms:
        result["telegram"] = telegram_link(event_slug, bot_handle=handles.get("telegram"), partner_id=partner_id, tab=tab, contact_id=contact_id, link_mode=link_mode)
    if "vk" in platforms:
        result["vk"] = vk_link(event_slug, app_id=vk_app_id, partner_id=partner_id, tab=tab, contact_id=contact_id, link_mode=link_mode)
    if "max" in platforms:
        result["max"] = max_link(event_slug, bot_handle=handles.get("max"), partner_id=partner_id, tab=tab, contact_id=contact_id, link_mode=link_mode)
    return result


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
    - TG: `t.me/{bot_handle}?start={kind}_{slug}` (VIP-бот клиента или @pluson_bot)
    - VK: `vk.com/app{vk_app_id}#{kind}_{slug}` (Mini App клиента)
    - MAX: `max.ru/{handle}?start={kind}_{slug}` (только если есть собственный MAX-бот)

    Логика показа платформы:
    - TG: VIP-бот клиента ИЛИ системный @pluson_bot (мультиклиентный через payload)
    - VK / MAX — ТОЛЬКО собственный канал клиента (системные принадлежат ПЛЮСОНу
      и не имеют права писать в личку подписчикам клиента).
    """
    if kind not in ("m", "p"):
        raise ValueError(f"kind must be 'm' or 'p', got {kind!r}")
    payload = f"{kind}_{slug}"
    handles = await get_client_bot_handles(db, client_id)
    result: dict[str, str] = {}

    # TG: VIP-бот клиента, либо системный @pluson_bot (мультиклиентный)
    tg_handle = handles.get("telegram") or PLUSON_TG_HANDLE
    if tg_handle == PLUSON_TG_HANDLE:
        if not await _has_system_channel(db, "telegram", allow_test=False):
            tg_handle = ""
    if tg_handle:
        result["telegram"] = f"https://t.me/{tg_handle.lstrip('@')}?start={payload}"

    # VK: собственное сообщество клиента (его vk_app_id), либо системный VK
    # Mini App ПЛЮСОНа (если выведен клиентам, is_test=FALSE). Системный VK Mini App
    # парсит `m_<slug>`/`p_<slug>` в hash и сам запускает воронку — для этого ему
    # не нужно писать в личку (в отличие от событий). Аналогично TG.
    if handles.get("vk"):
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            result["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"
    elif await _has_system_channel(db, "vk", allow_test=False):
        result["vk"] = f"https://vk.com/app{PLUSON_VK_APP_ID}#{payload}"

    # MAX: собственный MAX-бот клиента, либо системный MAX-бот ПЛЮСОНа
    # (если выведен клиентам, is_test=FALSE).
    if handles.get("max"):
        result["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?start={payload}"
    elif await _has_system_channel(db, "max", allow_test=False):
        result["max"] = f"https://max.ru/{PLUSON_MAX_HANDLE}?start={payload}"

    return result


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

    tg_handle = handles.get("telegram") or PLUSON_TG_HANDLE
    if tg_handle == PLUSON_TG_HANDLE:
        if not await _has_system_channel(db, "telegram", allow_test=False):
            tg_handle = ""
    if tg_handle:
        result["telegram"] = f"https://t.me/{tg_handle.lstrip('@')}?start={payload}"

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

    tg_handle = handles.get("telegram") or PLUSON_TG_HANDLE
    if tg_handle == PLUSON_TG_HANDLE:
        if not await _has_system_channel(db, "telegram", allow_test=False):
            tg_handle = ""
    if tg_handle:
        result["telegram"] = f"https://t.me/{tg_handle.lstrip('@')}?start={payload}"

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

    tg_handle = handles.get("telegram") or PLUSON_TG_HANDLE
    if tg_handle == PLUSON_TG_HANDLE:
        if not await _has_system_channel(db, "telegram", allow_test=False):
            tg_handle = ""
    if tg_handle:
        result["telegram"] = f"https://t.me/{tg_handle.lstrip('@')}?start={payload}"

    if handles.get("vk"):
        vk_app_id = await get_client_vk_app_id(db, client_id)
        if vk_app_id:
            result["vk"] = f"https://vk.com/app{vk_app_id}#{payload}"

    if handles.get("max"):
        result["max"] = f"https://max.ru/{handles['max'].lstrip('@')}?startapp={payload}"

    return result
