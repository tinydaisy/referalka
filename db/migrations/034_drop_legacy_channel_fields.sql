-- ═══════════════════════════════════════════
-- Миграция 034: удалить унаследованные поля после переезда в channels/platform_user_channels
--
-- Должна применяться ОДНОВРЕМЕННО с обновлением кода (новый код больше не использует
-- clients.bot_token, platform_users.platform, platform_users.is_unsubscribed).
-- ═══════════════════════════════════════════

BEGIN;

-- ── platform_users ──────────────────────────
-- Сменить UNIQUE с (client_id, platform, platform_user_id) на (client_id, platform_user_id)
ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_client_id_platform_platform_user_id_key;
ALTER TABLE platform_users ADD CONSTRAINT platform_users_client_id_platform_user_id_key
    UNIQUE (client_id, platform_user_id);

-- Удалить старые поля
ALTER TABLE platform_users DROP COLUMN IF EXISTS platform;
ALTER TABLE platform_users DROP COLUMN IF EXISTS is_unsubscribed;

-- Поправить индекс по platform/platform_user_id (был с polу-уникальностью)
DROP INDEX IF EXISTS idx_platform_users_platform_uid;
CREATE INDEX IF NOT EXISTS idx_platform_users_platform_user ON platform_users(platform_user_id);

-- ── clients ─────────────────────────────────
-- bot_token теперь в channels.bot_token
ALTER TABLE clients DROP COLUMN IF EXISTS bot_token;

COMMIT;
