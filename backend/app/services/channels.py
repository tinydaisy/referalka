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


async def upsert_client_telegram_token(client_id: int, bot_token: str, db) -> None:
    """Сохраняет bot_token в telegram-канале клиента. Если канала нет — создаёт его."""
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
        c = await db.fetchrow(
            "SELECT name, telegram_username FROM clients WHERE id = $1", client_id
        )
        await db.execute(
            """INSERT INTO channels (client_id, platform_slug, display_name, handle, bot_token, is_active)
               VALUES ($1, 'telegram', $2, $3, $4, TRUE)""",
            client_id,
            'Telegram бот ' + (('@' + c['telegram_username']) if c and c['telegram_username'] else (c['name'] if c else '')),
            ('@' + c['telegram_username']) if c and c['telegram_username'] else None,
            bot_token
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
