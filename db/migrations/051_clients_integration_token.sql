-- 2026-04-29: Per-client integration token для API чат-ботов (Salebot, BotHelp, ...).
-- Заменяет глобальный SALEBOT_SECRET. Каждому клиенту выдаётся свой токен,
-- который он видит в Настройки → Интеграция и может перевыпустить.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS integration_token TEXT;

-- Backfill: сгенерировать токен всем клиентам у кого его ещё нет.
-- 32 байта → 64 hex-символа, ≈256 бит энтропии. Хватит с большим запасом.
UPDATE clients
   SET integration_token = encode(gen_random_bytes(32), 'hex')
 WHERE integration_token IS NULL;

ALTER TABLE clients
  ALTER COLUMN integration_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_integration_token
  ON clients(integration_token);
