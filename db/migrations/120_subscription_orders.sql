-- 120_subscription_orders.sql
-- Заказы на оплату подписки ПЛЮСОНа через Prodamus.
--
-- Поток:
--   1. Клиент в /dashboard/settings → Подписка выбирает тариф и жмёт «Оплатить»
--      → POST /api/v1/subscriptions/order → INSERT с status='created'.
--      Возвращается ссылка Prodamus вида `{tariffs.prodamus_payment_url}?order_id={id}&customer_email=…`.
--   2. Клиент платит на Prodamus → Prodamus шлёт POST на наш webhook
--      `/api/v1/integrations/prodamus/webhook` → находим order по `order_id`,
--      ставим status='paid', продлеваем `client_subscriptions` на
--      `tariffs.default_duration_days`. В Этапе 3 — начисление 10% реферу.
--   3. Если webhook не пришёл (ошибка оплаты) — order остаётся в `created`
--      пока его не вычистит крон или клиент не попробует снова.
--
-- Сумма (`amount_total_kopecks`) фиксируется в момент создания order'a из
-- `tariffs.price` (для аудита: цена в Prodamus могла поменяться). Реально
-- оплаченная сумма (`amount_paid_card_kopecks`) приходит в webhook как `sum`.
--
-- `amount_paid_bonus_kopecks` заполнится в Этапе 3 при оплате бонусами.
-- В Этапе 2 всегда = 0.

CREATE TABLE IF NOT EXISTS subscription_orders (
  id                        SERIAL PRIMARY KEY,
  client_id                 INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tariff_id                 INTEGER NOT NULL REFERENCES tariffs(id),
  amount_total_kopecks      INTEGER NOT NULL,
  amount_paid_card_kopecks  INTEGER NOT NULL DEFAULT 0,
  amount_paid_bonus_kopecks INTEGER NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','cancelled')),
  prodamus_order_num        TEXT NULL,
  prodamus_payment_type     TEXT NULL,
  prodamus_raw              JSONB NULL,
  paid_at                   TIMESTAMPTZ NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscription_orders_client_idx ON subscription_orders (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_orders_status_idx ON subscription_orders (status, created_at DESC);

-- Связь подписки с конкретной оплатой (для аудита и истории)
ALTER TABLE client_subscriptions
  ADD COLUMN IF NOT EXISTS subscription_order_id INTEGER NULL REFERENCES subscription_orders(id);

-- GRANTы
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plusson') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_orders TO plusson';
    EXECUTE 'GRANT USAGE, SELECT ON subscription_orders_id_seq TO plusson';
  END IF;
END $$;
