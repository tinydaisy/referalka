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


async def find_channel_by_bot_id(bot_id: int, db) -> Optional[dict]:
    """По telegram bot id (число до двоеточия в токене) ищет соответствующий
    activный telegram-канал. Используется в bot-handlers где известен только
    `message.bot.id`, чтобы понять кому принадлежит этот бот.

    Возвращает {id, client_id} или None.
    """
    row = await db.fetchrow(
        """SELECT id, client_id FROM channels
            WHERE platform_slug = 'telegram'
              AND bot_token LIKE $1
            ORDER BY is_active DESC, id ASC
            LIMIT 1""",
        f"{bot_id}:%"
    )
    return dict(row) if row else None


async def register_telegram_subscription(
    client_id: int,
    channel_id: int,
    tg_id: str,
    *,
    username: str = "",
    first_name: str = "",
    last_name: str = "",
    db = None,
) -> Optional[int]:
    """Регистрирует пользователя как подписчика конкретного TG-канала клиента.

    Шаги (всё в транзакции):
      1. UPSERT contacts (если контакт нашёлся по другому платформ-каналу — мердж)
      2. UPSERT platform_users (по client_id + platform_slug + platform_user_id)
      3. UPSERT platform_user_channels с is_unsubscribed=FALSE (снимает галку
         если был отписан раньше — re-subscribe).

    Возвращает platform_users.id или None при ошибке.

    Зовётся из:
      - bot/handlers/start.py при /start (первое касание с ботом)
      - bot/handlers/chat_member.py при возврате (member status)
      - app/api/event.py при event_start из Mini App (на случай если /start
        был пропущен — Mini App открыт сразу через Menu Button)
    """
    if not tg_id or not channel_id or not client_id:
        return None
    async with db.transaction():
        # 1. platform_users — UPSERT по (client_id, platform_slug, platform_user_id)
        pu_row = await db.fetchrow(
            """SELECT id, contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'telegram'
                  AND platform_user_id = $2""",
            client_id, tg_id
        )
        if pu_row:
            pu_id = pu_row["id"]
            contact_id = pu_row["contact_id"]
            # Дозаполняем пустые поля username/first_name/last_name
            await db.execute(
                """UPDATE platform_users
                      SET username   = COALESCE(NULLIF(username,''),   $2),
                          first_name = COALESCE(NULLIF(first_name,''), $3),
                          last_name  = COALESCE(NULLIF(last_name,''),  $4),
                          updated_at = NOW()
                    WHERE id = $1""",
                pu_id, username or "", first_name or "", last_name or ""
            )
        else:
            # Создаём contacts (без email/phone — у нас только tg_id)
            display_name = (first_name + " " + last_name).strip() or username or f"TG {tg_id}"
            contact_id = await db.fetchval(
                """INSERT INTO contacts (client_id, name) VALUES ($1, $2) RETURNING id""",
                client_id, display_name
            )
            pu_id = await db.fetchval(
                """INSERT INTO platform_users
                   (client_id, contact_id, platform_slug, platform_user_id, username, first_name, last_name)
                   VALUES ($1, $2, 'telegram', $3, $4, $5, $6) RETURNING id""",
                client_id, contact_id, tg_id, username or "", first_name or "", last_name or ""
            )

        # 2. platform_user_channels — UPSERT с is_unsubscribed=FALSE
        await db.execute(
            """INSERT INTO platform_user_channels
                 (platform_user_id, channel_id, platform_slug, is_unsubscribed, subscribed_at)
               VALUES ($1, $2, 'telegram', FALSE, NOW())
               ON CONFLICT (platform_user_id, channel_id) DO UPDATE
                 SET is_unsubscribed  = FALSE,
                     subscribed_at    = COALESCE(platform_user_channels.subscribed_at, NOW()),
                     unsubscribed_at  = NULL""",
            pu_id, channel_id
        )
    return pu_id


async def mark_unsubscribed_by_tg_id(client_id: int, tg_id: str, db, channel_id: Optional[int] = None) -> None:
    """Помечает контакт отписавшимся на telegram-канале клиента.

    Если `channel_id` не передан — берётся главный telegram-канал клиента.
    Если передан — отметка ставится именно для него (используется в воркере
    рассылок: блокировку фиксируем для того канала, через который реально слали)."""
    if channel_id is None:
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


async def get_telegram_send_targets(client_id: int, tg_ids: list[str], db) -> dict[str, dict]:
    """Для каждого `platform_user_id` (tg_id) возвращает канал, через который
    нужно слать рассылку: тот, на который человек реально подписан.

    Приоритет:
      1) канал, отмеченный как «главный» (is_active=TRUE) и не-отписанный;
      2) любой не-отписанный канал;
      3) если нет подписок вовсе — каналу передаём главный (fallback).

    Возвращает: { tg_id: {"bot_token": "...", "channel_id": 12} }.
    Те, для кого не нашли никакого telegram-канала с токеном — отсутствуют в map.
    """
    if not tg_ids:
        return {}
    rows = await db.fetch(
        """
        WITH ranked AS (
          SELECT
              pu.platform_user_id AS tg_id,
              ch.id AS channel_id,
              ch.bot_token,
              ROW_NUMBER() OVER (
                  PARTITION BY pu.platform_user_id
                  ORDER BY ch.is_active DESC, ch.id ASC
              ) AS rn
            FROM platform_users pu
            JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
            JOIN channels ch ON ch.id = puc.channel_id
           WHERE pu.client_id = $1
             AND pu.platform_slug = 'telegram'
             AND ch.platform_slug = 'telegram'
             AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
             AND puc.is_unsubscribed = FALSE
             AND pu.platform_user_id = ANY($2::text[])
        )
        SELECT tg_id, channel_id, bot_token FROM ranked WHERE rn = 1
        """,
        client_id, tg_ids
    )
    return {
        r["tg_id"]: {"bot_token": r["bot_token"], "channel_id": r["channel_id"]}
        for r in rows
    }
