-- ═══════════════════════════════════════════
-- Миграция 033: мультиплатформа — channels + platform_user_channels
--
-- Этап 2А (создаём + заполняем). Старые поля (clients.bot_token, platform_users.platform,
-- platform_users.is_unsubscribed) пока ОСТАЮТСЯ — старый код продолжает работать.
-- Удаление старых полей — отдельной миграцией 034 после переписывания кода.
--
-- Концепция:
--   channels — каналы доставки клиента (бот в TG / группа VK / канал MAX)
--   platform_user_channels — подписка контакта на конкретный канал, is_unsubscribed per-канал
-- ═══════════════════════════════════════════

BEGIN;

-- ── channels ────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL CHECK (platform IN ('telegram', 'vk', 'max')),
    display_name    TEXT NOT NULL,
    handle          TEXT,                     -- @bot_username / vk_group_id / max_channel_id
    bot_token       TEXT,                     -- секрет канала
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_client      ON channels(client_id);
CREATE INDEX IF NOT EXISTS idx_channels_active      ON channels(client_id, is_active);

-- Заполнение: для каждого клиента с заполненным bot_token — одна строка telegram-канала
INSERT INTO channels (client_id, platform, display_name, handle, bot_token, is_active)
SELECT c.id,
       'telegram',
       'Telegram бот ' || COALESCE('@' || c.telegram_username, c.name),
       CASE WHEN c.telegram_username IS NOT NULL THEN '@' || c.telegram_username ELSE NULL END,
       c.bot_token,
       TRUE
FROM clients c
WHERE c.bot_token IS NOT NULL AND c.bot_token <> ''
  AND NOT EXISTS (SELECT 1 FROM channels WHERE client_id = c.id AND platform = 'telegram');

-- ── platform_user_channels ──────────────────
CREATE TABLE IF NOT EXISTS platform_user_channels (
    id                SERIAL PRIMARY KEY,
    platform_user_id  INTEGER NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    is_unsubscribed   BOOLEAN NOT NULL DEFAULT FALSE,
    subscribed_at     TIMESTAMPTZ,
    unsubscribed_at   TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(platform_user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_puc_user      ON platform_user_channels(platform_user_id);
CREATE INDEX IF NOT EXISTS idx_puc_channel   ON platform_user_channels(channel_id);
CREATE INDEX IF NOT EXISTS idx_puc_active    ON platform_user_channels(channel_id) WHERE is_unsubscribed = FALSE;

-- Заполнение: для каждого platform_users — связь с telegram-каналом своего клиента
-- Берём is_unsubscribed как было
INSERT INTO platform_user_channels (platform_user_id, channel_id, is_unsubscribed, subscribed_at)
SELECT pu.id,
       ch.id,
       COALESCE(pu.is_unsubscribed, FALSE),
       pu.created_at
FROM platform_users pu
JOIN channels ch ON ch.client_id = pu.client_id AND ch.platform = pu.platform
WHERE NOT EXISTS (
    SELECT 1 FROM platform_user_channels puc
    WHERE puc.platform_user_id = pu.id AND puc.channel_id = ch.id
);

COMMIT;
