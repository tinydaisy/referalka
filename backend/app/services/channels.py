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


async def register_platform_channel_subscription(
    client_id: int,
    platform_slug: str,
    platform_user_id: int,
    db,
) -> Optional[int]:
    """Подписывает уже существующую идентичность (platform_users.id) на ГЛАВНЫЙ
    активный канал клиента той же платформы.

    Нужно для VK/MAX-входа в событие: контакт + platform_users там создаются через
    upsert_contact_with_identity, но шаг привязки к каналу (как register_telegram_subscription
    делает для TG) отсутствовал — человек не попадал в подписчиков канала и в рассылку.

    Вызывается при ВХОДЕ человека в бота (bot_started / message_created), то есть
    он сам пришёл и запустил диалог — это явный сигнал «я снова с вами». Поэтому
    при ON CONFLICT подписку ВОЗВРАЩАЕМ (is_unsubscribed=FALSE), даже если ранее
    стояла отписка (например, MAX прислал bot_stopped при перезапуске бота).
    Зеркало register_telegram_subscription, который тоже re-subscribe-ит.
    Возвращает client_channel_id или None если у клиента нет активного канала этой платформы.
    """
    import logging
    log = logging.getLogger(__name__)
    if not platform_user_id or not client_id or not platform_slug:
        return None
    cc_id = await db.fetchval(
        """SELECT cc.id
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND ch.platform_slug = $2
              AND cc.is_active = TRUE
            ORDER BY cc.id LIMIT 1""",
        client_id, platform_slug,
    )
    if not cc_id:
        log.warning(
            "register_platform_channel_subscription: у клиента %s нет активного %s-канала "
            "(подписка не зарегистрирована для pu=%s).",
            client_id, platform_slug, platform_user_id,
        )
        return None
    await db.execute(
        """INSERT INTO platform_user_channels
             (platform_user_id, client_channel_id, is_unsubscribed, subscribed_at)
           VALUES ($1, $2, FALSE, NOW())
           ON CONFLICT (platform_user_id, client_channel_id)
           DO UPDATE SET is_unsubscribed = FALSE,
                         unsubscribed_at = NULL,
                         subscribed_at = COALESCE(platform_user_channels.subscribed_at, NOW())""",
        platform_user_id, cc_id,
    )
    return cc_id


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
            """SELECT pu.id, pu.contact_id FROM platform_users pu
                JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE c_own.client_id = $1 AND pu.platform_slug = 'telegram'
                  AND pu.platform_user_id = $2""",
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
            # contacts.ref_code NOT NULL UNIQUE с миграции 060 — генерируем через общий helper
            from app.services.contact_merge import _generate_unique_ref_code
            ref_code = await _generate_unique_ref_code(db)
            contact_id = await db.fetchval(
                """INSERT INTO contacts (client_id, name, ref_code)
                   VALUES ($1, $2, $3) RETURNING id""",
                client_id, display_name, ref_code,
            )
            pu_id = await db.fetchval(
                """INSERT INTO platform_users
                   (contact_id, platform_slug, platform_user_id, username, first_name, last_name)
                   VALUES ($1, 'telegram', $2, $3, $4, $5) RETURNING id""",
                contact_id, tg_id, username or "", first_name or "", last_name or ""
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
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE c_own.client_id = $2 AND pu.platform_slug = 'telegram' AND pu.platform_user_id = $3
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


async def get_bot_handle_for_user(client_id: int, tg_id: str, db) -> Optional[str]:
    """Хендл бота, через который пользователь «живёт» у клиента.

    Используется в уведомлениях клиенту («Бот: @ivision_conf_bot»).
    Логика: ищем активные подписки этого tg_id в контексте client_id, выбираем
    канал с приоритетом is_active=TRUE и не-системный. Если подписок нет —
    fallback на главный активный канал клиента (он же и сработает в рассылках
    через default_bot_token).
    """
    handle = await db.fetchval(
        """SELECT ch.handle
             FROM platform_user_channels puc
             JOIN platform_users pu ON pu.id = puc.platform_user_id
             JOIN client_channels cc ON cc.id = puc.client_channel_id
             JOIN channels ch ON ch.id = cc.channel_id
             JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE c_own.client_id = $1
              AND pu.platform_slug = 'telegram'
              AND pu.platform_user_id = $2
              AND ch.platform_slug = 'telegram'
              AND puc.is_unsubscribed = FALSE
            ORDER BY cc.is_active DESC, ch.is_system ASC, ch.id ASC
            LIMIT 1""",
        client_id, tg_id,
    )
    if handle:
        return handle
    # Fallback — главный активный канал клиента.
    return await db.fetchval(
        """SELECT ch.handle FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1 AND ch.platform_slug = 'telegram'
            ORDER BY cc.is_active DESC, ch.is_system ASC, ch.id ASC
            LIMIT 1""",
        client_id,
    )


async def get_telegram_send_targets(client_id: int, tg_ids: list[str], db) -> dict[str, list[dict]]:
    """Для каждого tg_id — СПИСОК каналов клиента, на которые он не отписан.

    Fanout-поведение: один контакт получает по N сообщений (по числу подписок).
    Порядок внутри списка: главный канал (is_active=TRUE) первым.

    Возвращает: { tg_id: [{"bot_token": "...", "channel_id": 12, "client_channel_id": 99}, ...] }.
    tg_id без активных подписок отсутствует в map — получит сообщение через
    fallback (главный/единственный канал клиента) в вызывающем коде.
    """
    if not tg_ids:
        return {}
    rows = await db.fetch(
        """
        SELECT
            pu.platform_user_id AS tg_id,
            ch.id AS channel_id,
            cc.id AS client_channel_id,
            ch.bot_token
          FROM platform_users pu
          JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
          JOIN client_channels cc ON cc.id = puc.client_channel_id
          JOIN channels ch ON ch.id = cc.channel_id
          JOIN contacts c_own ON c_own.id = pu.contact_id
         WHERE c_own.client_id = $1
           AND pu.platform_slug = 'telegram'
           AND ch.platform_slug = 'telegram'
           AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
           AND puc.is_unsubscribed = FALSE
           AND pu.platform_user_id = ANY($2::text[])
         ORDER BY pu.platform_user_id, cc.is_active DESC, ch.id ASC
        """,
        client_id, tg_ids
    )
    result: dict[str, list[dict]] = {}
    for r in rows:
        result.setdefault(r["tg_id"], []).append({
            "bot_token": r["bot_token"],
            "channel_id": r["channel_id"],
            "client_channel_id": r["client_channel_id"],
        })
    return result


async def get_client_vip_telegram_token(client_id: int, db) -> Optional[str]:
    """bot_token СОБСТВЕННОГО (VIP) telegram-бота клиента — строго is_system=FALSE.

    В отличие от get_client_telegram_token (берёт любой активный канал, включая
    системный через client_channels) — этот вернёт токен ТОЛЬКО если у клиента
    подключён свой бот. Нужен там, где fallback на системный делается осознанно.
    """
    return await db.fetchval(
        """SELECT ch.bot_token
             FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'telegram'
              AND ch.is_system = FALSE
              AND cc.is_active = TRUE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY ch.id LIMIT 1""",
        client_id,
    )


async def send_to_notifications_channel(
    client_id: int, chat_id, text: str, db, *, parse_mode: str = "HTML"
) -> bool:
    """Отправка служебного уведомления в канал уведомлений клиента
    (clients.notifications_telegram_chat_id).

    Бот: ТОЛЬКО свой (VIP) бот клиента. Системный @pluson_bot как fallback убран —
    он используется только для самого ПЛЮСОНа. Нет своего TG-бота → уведомление в
    Telegram не уходит (клиент видит интерес в кабинете; email-канал работает отдельно).

    Возвращает True если доставлено.
    """
    import httpx

    if not chat_id or not text:
        return False

    vip_token = await get_client_vip_telegram_token(client_id, db)
    if not vip_token:
        return False
    tokens: list[str] = [vip_token]

    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    for tok in tokens:
        try:
            async with httpx.AsyncClient(timeout=10) as http:
                r = await http.post(
                    f"https://api.telegram.org/bot{tok}/sendMessage", json=payload
                )
            if r.status_code == 200 and r.json().get("ok"):
                return True
        except Exception:  # noqa: BLE001 — пробуем следующий токен
            continue
    return False


async def get_client_max_token(client_id: int, db) -> Optional[str]:
    """Токен MAX-бота клиента (его VIP MAX-бот). None если нет."""
    return await db.fetchval(
        """SELECT ch.bot_token FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1 AND ch.platform_slug = 'max'
              AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY cc.is_active DESC, cc.id ASC LIMIT 1""",
        client_id,
    )


async def get_client_vk_token(client_id: int, db) -> Optional[str]:
    """Токен VK-сообщества клиента. None если нет."""
    return await db.fetchval(
        """SELECT ch.bot_token FROM channels ch
             JOIN client_channels cc ON cc.channel_id = ch.id
            WHERE cc.client_id = $1 AND ch.platform_slug = 'vk'
              AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            ORDER BY cc.is_active DESC, cc.id ASC LIMIT 1""",
        client_id,
    )


async def notify_organizer_all_channels(
    client_id: int, text_html: str, db, *, text_plain: Optional[str] = None,
    kind: str = "general",
) -> dict:
    """ЕДИНАЯ точка отправки уведомления организатору во ВСЕ его каналы уведомлений:
    Telegram + MAX + VK. Уведомление ДУБЛИРУЕТСЯ в каждый заполненный канал,
    независимо от площадки человека (правило клиента — «слать во все»).

    - TG  — HTML (clients.notifications_telegram_chat_id) ботом клиента.
    - MAX — plain-текст (clients.notifications_max_chat_id) MAX-ботом клиента.
            MAX не поддерживает HTML так же — шлём text_plain (или strip тегов).
    - VK  — plain-текст (clients.notifications_vk_peer_id) сообществом клиента.

    kind='payments' (миграция 259) → уведомления об ОПЛАТАХ идут в отдельный
    канал: в общем они теряются среди «новых интересов» и вопросов, а оплаты
    нужно видеть сразу и часто показывать другим людям. Если отдельный канал
    не задан — падаем на общий, чтобы уведомление не пропало.

    Пустое поле канала / нет токена бота на платформе → канал пропускается (graceful).
    Возвращает {'tg': bool, 'max': bool, 'vk': bool}.
    """
    row = await db.fetchrow(
        """SELECT notifications_telegram_chat_id, notifications_max_chat_id,
                  notifications_vk_peer_id,
                  payments_telegram_chat_id, payments_max_chat_id,
                  payments_vk_peer_id
             FROM clients WHERE id = $1""",
        client_id,
    )
    if row and kind == "payments":
        # Отдельный канал оплат, а где не задан — общий.
        row = {
            "notifications_telegram_chat_id":
                row["payments_telegram_chat_id"] or row["notifications_telegram_chat_id"],
            "notifications_max_chat_id":
                row["payments_max_chat_id"] or row["notifications_max_chat_id"],
            "notifications_vk_peer_id":
                row["payments_vk_peer_id"] or row["notifications_vk_peer_id"],
        }
    result = {"tg": False, "max": False, "vk": False}
    if not row or not text_html:
        return result

    plain = text_plain or _strip_html(text_html)

    # ── Telegram ──
    if row["notifications_telegram_chat_id"]:
        result["tg"] = await send_to_notifications_channel(
            client_id, row["notifications_telegram_chat_id"], text_html, db
        )

    # ── MAX ──
    # ⚠️ Шлём HTML, а НЕ голый текст. Раньше здесь стоял `plain` (_strip_html), и
    # вместе с тегами вырезалось УПОМИНАНИЕ человека — единственный способ попасть
    # из уведомления в личный диалог в MAX (ссылок на профиль по id или телефону
    # у MAX нет вовсе, см. profile_links.max_mention_html). Без `format="html"`
    # MAX разметку не разбирает, поэтому parse_mode обязателен.
    # Блочные теги MAX не понимает — их приводит html_to_telegram (та же чистка,
    # что в рассылках): <br> → перенос, <b>/<i>/<a> остаются как есть.
    if row["notifications_max_chat_id"]:
        try:
            max_token = await get_client_max_token(client_id, db)
            if max_token:
                from app.services.max_api import send_message as max_send
                from app.services.message_builder import html_to_telegram
                await max_send(
                    row["notifications_max_chat_id"],
                    html_to_telegram(text_html),
                    token=max_token,
                    parse_mode="html",
                )
                result["max"] = True
        except Exception:  # noqa: BLE001 — не роняем остальные каналы
            pass

    # ── VK ──
    if row["notifications_vk_peer_id"]:
        try:
            vk_token = await get_client_vk_token(client_id, db)
            if vk_token:
                import random as _rnd
                from app.services.vk_api import vk_call
                from app.services.message_builder import html_to_vk_text
                peer = int(row["notifications_vk_peer_id"])
                # peer_id ≥ 2000000000 = БЕСЕДА → слать через peer_id (user_id даёт
                # «incorrect user_id»). Меньше = личка пользователя → user_id.
                send_param = "peer_id" if peer >= 2_000_000_000 else "user_id"
                await vk_call("messages.send", {
                    send_param: peer,
                    "message": html_to_vk_text(plain) if plain else "",
                    "random_id": _rnd.randint(1, 2**31 - 1),
                    "dont_parse_links": 0,
                }, token=vk_token)
                result["vk"] = True
        except Exception:  # noqa: BLE001
            pass

    return result


def _strip_html(s: str) -> str:
    """Грубое снятие HTML-тегов для MAX/VK (они не парсят TG-HTML).
    <a href=URL>текст</a> → «текст (URL)», остальные теги срезаются.
    """
    import re
    # ссылки: вытащим URL рядом с текстом, чтобы был кликабельный адрес
    s = re.sub(r'<a\s+href="([^"]+)">(.*?)</a>', r'\2 (\1)', s, flags=re.IGNORECASE | re.DOTALL)
    s = re.sub(r'<[^>]+>', '', s)  # прочие теги
    # html entities назад
    s = (s.replace('&lt;', '<').replace('&gt;', '>')
           .replace('&amp;', '&').replace('&quot;', '"').replace('&#39;', "'"))
    return s
