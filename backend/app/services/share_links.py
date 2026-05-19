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


def telegram_link(event_slug: str, *, bot_handle: str | None = None, partner_id: str | None = None, tab: str | None = None) -> str:
    """Реф-ссылка в Telegram Mini App."""
    handle = (bot_handle or PLUSON_TG_HANDLE).lstrip('@')
    # У общего @pluson_bot Mini App имеет short-name `pluson` (one 's')
    # У VIP-бота Main Mini App без short-name — `t.me/{handle}?startapp=…`
    app_part = f"/{PLUSON_TG_APP}" if handle == PLUSON_TG_HANDLE else ""
    parts = [f"ref_pg{event_slug}"]
    if partner_id:
        parts.append(f"pid{partner_id}")
    if tab:
        parts.append(f"tab{tab}")
    return f"https://t.me/{handle}{app_part}?startapp={'_'.join(parts)}"


def vk_link(event_slug: str, *, app_id: int | None = None, partner_id: str | None = None, tab: str | None = None) -> str:
    """Реф-ссылка в VK Mini App. VK передаёт стартовые параметры через hash (#)."""
    aid = app_id or PLUSON_VK_APP_ID
    parts = [f"ref_pg{event_slug}"]
    if partner_id:
        parts.append(f"pid{partner_id}")
    if tab:
        parts.append(f"tab{tab}")
    return f"https://vk.com/app{aid}#{'_'.join(parts)}"


def max_link(event_slug: str, *, bot_handle: str | None = None, partner_id: str | None = None, tab: str | None = None) -> str:
    """Заглушка для MAX. Пока не используется — добавим когда подключим MAX-бот."""
    handle = bot_handle or "pluson_max_bot"
    parts = [f"ref_pg{event_slug}"]
    if partner_id:
        parts.append(f"pid{partner_id}")
    if tab:
        parts.append(f"tab{tab}")
    return f"https://max.ru/{handle}?startapp={'_'.join(parts)}"


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


async def build_share_links(
    db,
    *,
    client_id: int,
    event_slug: str,
    partner_id: Optional[str] = None,
    tab: Optional[str] = None,
) -> dict[str, str]:
    """Возвращает {platform → url} для всех **активных** платформ клиента.

    Если у клиента есть свой бот/сообщество — используется его handle. Иначе системный.
    """
    platforms = await get_active_platforms(db, client_id)
    handles = await get_client_bot_handles(db, client_id)
    # Гарантируем что для системного клиента (без своих каналов) есть TG + VK с системными ботами
    if not platforms:
        platforms = ["telegram", "vk"]
    result: dict[str, str] = {}
    if "telegram" in platforms:
        result["telegram"] = telegram_link(event_slug, bot_handle=handles.get("telegram"), partner_id=partner_id, tab=tab)
    if "vk" in platforms:
        # VK app_id всегда системный пока не поддержим VIP-VK
        result["vk"] = vk_link(event_slug, partner_id=partner_id, tab=tab)
    if "max" in platforms:
        result["max"] = max_link(event_slug, bot_handle=handles.get("max"), partner_id=partner_id, tab=tab)
    return result
