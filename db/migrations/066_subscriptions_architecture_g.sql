-- 066_subscriptions_architecture_g.sql
-- Подписочная архитектура G:
--   1. channels — самостоятельная сущность БЕЗ client_id (нормализация)
--      + флаг is_system (общий канал ПЛЮСОНа: @pluson_bot, MAX, VK)
--      + флаг is_test  (системный в тестовом режиме, ещё НЕ выдан клиентам)
--   2. client_channels — junction-таблица «канал доступен клиенту»
--      содержит is_active (главный канал клиента на платформе)
--   3. platform_user_channels — подписки переводятся с FK channel_id на client_channel_id
--      это даёт явное разделение «подписчик контекста клиента X на канал Y»
--      и убирает риск утечки между клиентами
--
-- Что после миграции:
--   - В channels будут только VIP-боты клиентов (1 запись на бот) + системные.
--   - client_channels: для VIP — по 1 записи на (клиент×канал клиента); для системного
--     активного (is_test=FALSE) — по 1 записи на каждого клиента.
--   - platform_user_channels.client_channel_id указывает на конкретный (клиент×канал)
--     контекст подписки.
--
-- Системный клиент «ПЛЮСОН Сервис» создаётся отдельной командой (Backfill) — для
-- учёта контактов которые пришли через @pluson_bot напрямую, без реф/события.

BEGIN;

-- ========== 1. channels: новые колонки ==========
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_test   BOOLEAN NOT NULL DEFAULT FALSE;

-- is_test может быть TRUE только если is_system=TRUE
ALTER TABLE channels ADD CONSTRAINT chk_channels_test_only_for_system
  CHECK (is_test = FALSE OR is_system = TRUE);

-- ========== 2. client_channels: новая таблица ==========
CREATE TABLE IF NOT EXISTS client_channels (
  id          SERIAL PRIMARY KEY,
  client_id   INTEGER     NOT NULL REFERENCES clients(id),
  channel_id  INTEGER     NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  is_active   BOOLEAN     NOT NULL DEFAULT FALSE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, channel_id)
);

-- Перенос существующих привязок channels.client_id → client_channels
INSERT INTO client_channels (client_id, channel_id, is_active)
  SELECT client_id, id, is_active FROM channels WHERE client_id IS NOT NULL;

-- Уникальный индекс «один главный канал клиента на платформу»
-- (на client_channels через JOIN на channels.platform_slug — реализуем триггером,
-- т.к. в индекс PG нельзя положить подзапрос)
CREATE OR REPLACE FUNCTION enforce_one_active_per_platform()
RETURNS TRIGGER AS $$
DECLARE
  v_platform_slug TEXT;
BEGIN
  IF NEW.is_active = TRUE THEN
    SELECT platform_slug INTO v_platform_slug FROM channels WHERE id = NEW.channel_id;
    IF EXISTS (
      SELECT 1 FROM client_channels cc
        JOIN channels ch ON ch.id = cc.channel_id
       WHERE cc.client_id = NEW.client_id
         AND ch.platform_slug = v_platform_slug
         AND cc.is_active = TRUE
         AND cc.id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'У клиента уже есть активный канал на платформе %', v_platform_slug;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_one_active_per_platform
  BEFORE INSERT OR UPDATE ON client_channels
  FOR EACH ROW EXECUTE FUNCTION enforce_one_active_per_platform();

-- ========== 3. platform_user_channels: переключение FK ==========
-- Добавляем колонку client_channel_id, заполняем, делаем NOT NULL, сносим channel_id и platform_slug

ALTER TABLE platform_user_channels ADD COLUMN client_channel_id INTEGER;

-- Заполняем: для каждой подписки находим client_channels где
-- (client_id того же клиента что у platform_user, channel_id того же канала)
UPDATE platform_user_channels puc
   SET client_channel_id = cc.id
  FROM platform_users pu, client_channels cc
 WHERE puc.platform_user_id = pu.id
   AND cc.client_id = pu.client_id
   AND cc.channel_id = puc.channel_id;

-- Все строки должны заполниться. Если есть NULL — это сирота (подписка ссылается на канал
-- которого нет в client_channels этого клиента). Удаляем такие — они не должны существовать.
DELETE FROM platform_user_channels WHERE client_channel_id IS NULL;

-- Делаем NOT NULL и FK
ALTER TABLE platform_user_channels ALTER COLUMN client_channel_id SET NOT NULL;
ALTER TABLE platform_user_channels
  ADD CONSTRAINT fk_puc_client_channel
  FOREIGN KEY (client_channel_id) REFERENCES client_channels(id) ON DELETE CASCADE;

-- Уникальность подписки в контексте
ALTER TABLE platform_user_channels
  ADD CONSTRAINT uniq_puc_per_user_clientchannel
  UNIQUE (platform_user_id, client_channel_id);

-- Сносим старые FK и колонки которые больше не нужны
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_channel_id_fkey;
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_platform_user_id_fkey;
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_platform_slug_fkey;
-- Если были composite FK с platform_slug — тоже снести
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_platform_user_id_platform_slug_fkey;
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_channel_id_platform_slug_fkey;

-- Восстанавливаем simple FK на platform_users
ALTER TABLE platform_user_channels
  ADD CONSTRAINT fk_puc_platform_user
  FOREIGN KEY (platform_user_id) REFERENCES platform_users(id) ON DELETE CASCADE;

-- Удаляем старый UNIQUE (platform_user_id, channel_id) если был
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_platform_user_id_channel_id_key;

-- Убираем колонки channel_id и platform_slug
ALTER TABLE platform_user_channels DROP COLUMN channel_id;
ALTER TABLE platform_user_channels DROP COLUMN platform_slug;

-- ========== 4. channels: убираем client_id и is_active ==========
-- (is_active переехал в client_channels, client_id больше не нужен)

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_client_id_fkey;
ALTER TABLE channels DROP COLUMN client_id;

-- Сносим UNIQUE-индекс (client_id, platform_slug) WHERE is_active — он больше не имеет смысла
DROP INDEX IF EXISTS uniq_channels_active_per_client_platform;
DROP INDEX IF EXISTS channels_client_id_platform_slug_idx;

ALTER TABLE channels DROP COLUMN is_active;

COMMIT;
