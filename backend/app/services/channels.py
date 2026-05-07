"""
Helpers для работы с каналами доставки клиента (channels + client_channels).

После миграции 066 (Подписочная архитектура G):
- channels БЕЗ client_id (нормализация). Связь с клиентами через client_channels.
- channels.is_system = TRUE для общих каналов сервиса (@pluson_bot, MAX, VK).
- channels.is_test  = TRUE если системный канал в тестовом режиме (не выдан клиентам).
- client_channels (client_id, channel_id, is_active) — junction.
- platform_user_channels.client_channel_id — подписка в КОНКРЕТНОМ контексте (клиент×канал).

Семантика:
- bot_token живёт в channels.bot_token (для is_system — общий, разделяется между клиентами).
- is_unsubscribed — в platform_user_channels per-(контекст подписки).
"""
from typing import Optional


async def get_client_telegram_token(client_id: int, db) -> Optional[str]:
    """bot_token первого активного telegram-канала клиента (через client_channels)."""
    return await db.fetchval(
        """SELECT ch.bot_token
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND cc.is_active = TRUE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id LIMIT 1""",
        client_id
    )


async def get_client_telegram_channel_id(client_id: int, db) -> Optional[int]:
    """channels.id первого активного telegram-канала клиента."""
    return await db.fetchval(
        """SELECT ch.id
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND cc.is_active = TRUE
            ORDER BY ch.id LIMIT 1""",
        client_id
    )


async def get_client_channel_id(client_id: int, channel_id: int, db) -> Optional[int]:
    """client_channels.id для пары (client_id, channel_id). None если канал клиенту не доступен."""
    return await db.fetchval(
        "SELECT id FROM client_channels WHERE client_id = $1 AND channel_id = $2",
        client_id, channel_id
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
    """Сохраняет VIP-bot_token. Создаёт/обновляет channels (НЕ системный) + client_channels-запись.

    Для is_system=TRUE каналов токен нельзя менять через эту функцию — это запрещено в API.
    """
    existing = await db.fetchrow(
        """SELECT ch.id, cc.id AS cc_id, ch.is_system
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1 AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
            ORDER BY ch.id LIMIT 1""",
        client_id
    )
    if existing:
        await db.execute(
            "UPDATE channels SET bot_token = $1, updated_at = NOW() WHERE id = $2",
            bot_token or None, existing["id"]
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
        async with db.transaction():
            new_channel_id = await db.fetchval(
                """INSERT INTO channels (platform_slug, display_name, handle, bot_token, is_system, is_test)
                   VALUES ('telegram', $1, $2, $3, FALSE, FALSE) RETURNING id""",
                display_name, handle, bot_token
            )
            await db.execute(
                """INSERT INTO client_channels (client_id, channel_id, is_active)
                   VALUES ($1, $2, TRUE)""",
                client_id, new_channel_id
            )


async def find_channel_by_bot_id(bot_id: int, db) -> Optional[dict]:
    """По telegram bot id (число до двоеточия в токене) возвращает channels-запись.

    Возвращает {id, is_system} или None. Использовать для определения «какой это бот».
    Для регистрации подписки нужно дополнительно найти client_channel_id для конкретного client_id.
    """
    row = await db.fetchrow(
        """SELECT id, is_system FROM channels
            WHERE platform_slug = 'telegram'
              AND bot_token LIKE $1
            ORDER BY id ASC
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
    """Регистрирует пользователя как подписчика канала channel_id в контексте клиента client_id.

    Шаги (всё в транзакции):
      1. Проверить/создать client_channels запись для (client_id, channel_id).
         Для системных каналов запись должна существовать (создаётся при активации канала
         или регистрации клиента). Если её нет — это аномалия, лог и возврат None.
      2. UPSERT contacts (если контакт уже есть — берём его; иначе создаём).
      3. UPSERT platform_users (по client_id + platform_slug + platform_user_id).
      4. UPSERT platform_user_channels с is_unsubscribed=FALSE (re-subscribe если был отписан).

    Возвращает platform_users.id или None при ошибке.
    """
    import logging
    log = logging.getLogger(__name__)
    if not tg_id or not channel_id or not client_id:
        return None
    async with db.transaction():
        # 1. client_channel_id для (client_id, channel_id)
        cc_id = await db.fetchval(
            "SELECT id FROM client_channels WHERE client_id = $1 AND channel_id = $2",
            client_id, channel_id
        )
        if not cc_id:
            log.warning(
                "register_telegram_subscription: channel %s не доступен клиенту %s "
                "(нет записи в client_channels). Подписка не зарегистрирована.",
                channel_id, client_id
            )
            return None

        # 2. platform_users — UPSERT по (client_id, platform_slug, platform_user_id)
        pu_row = await db.fetchrow(
            """SELECT id, contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'telegram'
                  AND platform_user_id = $2""",
            client_id, tg_id
        )
        if pu_row:
            pu_id = pu_row["id"]
            # Дозаполняем пустые поля
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

        # 3. platform_user_channels — UPSERT
        await db.execute(
            """INSERT INTO platform_user_channels
                 (platform_user_id, client_channel_id, is_unsubscribed, subscribed_at)
               VALUES ($1, $2, FALSE, NOW())
               ON CONFLICT (platform_user_id, client_channel_id) DO UPDATE
                 SET is_unsubscribed  = FALSE,
                     subscribed_at    = COALESCE(platform_user_channels.subscribed_at, NOW()),
                     unsubscribed_at  = NULL""",
            pu_id, cc_id
        )
    return pu_id


async def mark_unsubscribed_by_tg_id(client_id: int, tg_id: str, db, channel_id: Optional[int] = None) -> None:
    """Помечает отписку контакта на канале (в контексте клиента).

    - channel_id передан → отметка для пары (client_id, channel_id) — конкретный контекст.
    - channel_id None → главный telegram-канал клиента (через get_client_telegram_channel_id).

    Используется в:
      - воркере рассылок (фиксируем 403 от Telegram)
      - bot/handlers/chat_member.py (kicked) — но там пометка идёт ВО ВСЕХ контекстах через
        отдельную логику mark_unsubscribed_globally (см. ниже).
    """
    if channel_id is None:
        channel_id = await get_client_telegram_channel_id(client_id, db)
    if not channel_id:
        return
    cc_id = await db.fetchval(
        "SELECT id FROM client_channels WHERE client_id = $1 AND channel_id = $2",
        client_id, channel_id
    )
    if not cc_id:
        return
    await db.execute(
        """INSERT INTO platform_user_channels
             (platform_user_id, client_channel_id, is_unsubscribed, unsubscribed_at)
           SELECT pu.id, $1, TRUE, NOW()
             FROM platform_users pu
            WHERE pu.client_id = $2 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $3
           ON CONFLICT (platform_user_id, client_channel_id) DO UPDATE
             SET is_unsubscribed = TRUE,
                 unsubscribed_at = COALESCE(platform_user_channels.unsubscribed_at, NOW())""",
        cc_id, client_id, tg_id
    )


async def mark_unsubscribed_globally(channel_id: int, tg_id: str, db) -> int:
    """Помечает отписку tg_id во ВСЕХ контекстах подписки на channel_id.

    Используется при my_chat_member 'kicked' для общего бота — юзер заблокировал бот,
    и его подписки для всех клиентов где он был учтён должны быть помечены отписанными.

    Возвращает количество обновлённых записей.
    """
    result = await db.execute(
        """UPDATE platform_user_channels puc
              SET is_unsubscribed = TRUE,
                  unsubscribed_at = NOW()
             FROM client_channels cc, platform_users pu
            WHERE puc.client_channel_id = cc.id
              AND cc.channel_id = $1
              AND puc.platform_user_id = pu.id
              AND pu.platform_slug = 'telegram'
              AND pu.platform_user_id = $2
              AND puc.is_unsubscribed = FALSE""",
        channel_id, tg_id
    )
    # asyncpg возвращает строку вида 'UPDATE 5' — извлечём число
    try:
        return int(str(result).split()[-1])
    except Exception:
        return 0


async def resubscribe_globally(channel_id: int, tg_id: str, db) -> int:
    """Снимает отписку (возвращает) tg_id во всех контекстах channel_id. При my_chat_member 'member'."""
    result = await db.execute(
        """UPDATE platform_user_channels puc
              SET is_unsubscribed = FALSE,
                  unsubscribed_at = NULL
             FROM client_channels cc, platform_users pu
            WHERE puc.client_channel_id = cc.id
              AND cc.channel_id = $1
              AND puc.platform_user_id = pu.id
              AND pu.platform_slug = 'telegram'
              AND pu.platform_user_id = $2
              AND puc.is_unsubscribed = TRUE""",
        channel_id, tg_id
    )
    try:
        return int(str(result).split()[-1])
    except Exception:
        return 0


async def get_telegram_send_targets(client_id: int, tg_ids: list[str], db) -> dict[str, dict]:
    """Для каждого tg_id (из списка) возвращает канал через который слать рассылку.

    Идёт через client_channels (контекст клиента), смотрит подписки этого клиента.

    Приоритет:
      1) is_active=TRUE канал не-отписанный
      2) любой не-отписанный канал клиента
      3) tg_id без подписок ни одного канала клиента — отсутствует в map (не получит сообщение)

    Возвращает: { tg_id: {"bot_token": "...", "channel_id": 12, "client_channel_id": 99} }.
    """
    if not tg_ids:
        return {}
    rows = await db.fetch(
        """
        WITH ranked AS (
          SELECT
              pu.platform_user_id AS tg_id,
              ch.id AS channel_id,
              cc.id AS client_channel_id,
              ch.bot_token,
              ROW_NUMBER() OVER (
                  PARTITION BY pu.platform_user_id
                  ORDER BY cc.is_active DESC, ch.id ASC
              ) AS rn
            FROM platform_users pu
            JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
            JOIN client_channels cc ON cc.id = puc.client_channel_id
            JOIN channels ch ON ch.id = cc.channel_id
           WHERE pu.client_id = $1
             AND pu.platform_slug = 'telegram'
             AND ch.platform_slug = 'telegram'
             AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
             AND puc.is_unsubscribed = FALSE
             AND pu.platform_user_id = ANY($2::text[])
        )
        SELECT tg_id, channel_id, client_channel_id, bot_token FROM ranked WHERE rn = 1
        """,
        client_id, tg_ids
    )
    return {
        r["tg_id"]: {
            "bot_token": r["bot_token"],
            "channel_id": r["channel_id"],
            "client_channel_id": r["client_channel_id"],
        }
        for r in rows
    }
