-- 070_clients_current_subscription_id.sql (07.05.2026)
-- Денормализованный указатель на активную подписку клиента.
-- ON DELETE SET NULL — если запись подписки удалят, ссылка обнуляется (не теряем клиента).
-- Заполняется в 072.

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS current_subscription_id INTEGER NULL
    REFERENCES client_subscriptions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_current_subscription
  ON clients(current_subscription_id);

COMMIT;
