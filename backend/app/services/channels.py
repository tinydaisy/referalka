"""
Helpers для работы с каналами доставки клиента (channels).

После миграций 033/034/036:
- bot_token живёт в channels.bot_token
- platform — в channels.platform_slug (FK на platforms.slug)
- is_unsubscribed — в platform_user_channels per-канал
"""
from typing import Optional


async def get_client_telegram_token(client_id: int, db) -> Optional[str]:
    """Возвращает bot_token первого активного telegram-канала клиента."""
    return await db.fetchval(
        """SELECT bot_token FROM channels
           WHERE client_id = $1 AND platform_slug = 'telegram' AND is_active = TRUE
             AND bot_token IS NOT NULL AND bot_token <> ''
           ORDER BY id LIMIT 1""",
        client_id
    )


async def get_client_telegram_channel_id(client_id: int, db) -> Optional[int]:
    """Возвращает id первого активного telegram-канала клиента."""
    return await db.fetchval(
        """SELECT id FROM channels
           WHERE client_id = $1 AND platform_slug = 'telegram' AND is_active = TRUE
           ORDER BY id LIMIT 1""",
        client_id
    )


async def _fetch_bot_username(bot_token: str) -> Optional[str]:
    """Спрашиваем у Telegram реальный @username бота через getMe. Без сети — None."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5) as http:
            r = await http.get(f"https://api.telegram.org/bot{bot_token}/getMe")
            data = r.json()
            if data.get("ok"):
                return data["result"].get("username")
    except Exception:
        pass
    return None


async def upsert_client_telegram_token(client_id: int, bot_token: str, db) -> None:
    """Сохраняет bot_token в telegram-канале клиента. Если канала нет — создаёт его,
    подтягивая username бота через getMe (а не из личного telegram_username клиента)."""
    existing = await db.fetchval(
        "SELECT id FROM channels WHERE client_id = $1 AND platform_slug = 'telegram' ORDER BY id LIMIT 1",
        client_id
    )
    if existing:
        await db.execute(
            "UPDATE channels SET bot_token = $1, updated_at = NOW() WHERE id = $2",
            bot_token or None, existing
        )
    elif bot_token:
        bot_username = await _fetch_bot_username(bot_token)
        c = await db.fetchrow("SELECT name FROM clients WHERE id = $1", client_id)
        if bot_username:
            display_name = f'Telegram бот @{bot_username}'
            handle = f'@{bot_username}'
        else:
            display_name = 'Telegram бот ' + (c['name'] if c else '')
            handle = None
        await db.execute(
            """INSERT INTO channels (client_id, platform_slug, display_name, handle, bot_token, is_active)
               VALUES ($1, 'telegram', $2, $3, $4, TRUE)""",
            client_id, display_name, handle, bot_token
        )


async def mark_unsubscribed_by_tg_id(client_id: int, tg_id: str, db) -> None:
    """Помечает контакт отписавшимся на telegram-канале клиента."""
    channel_id = await get_client_telegram_channel_id(client_id, db)
    if not channel_id:
        return
    await db.execute(
        """INSERT INTO platform_user_channels (platform_user_id, channel_id, platform_slug, is_unsubscribed, unsubscribed_at)
           SELECT pu.id, $1, 'telegram', TRUE, NOW()
             FROM platform_users pu
            WHERE pu.client_id = $2 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $3
           ON CONFLICT (platform_user_id, channel_id) DO UPDATE
             SET is_unsubscribed = TRUE,
                 unsubscribed_at = COALESCE(platform_user_channels.unsubscribed_at, NOW())""",
        channel_id, client_id, tg_id
    )
