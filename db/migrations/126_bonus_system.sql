-- 126_bonus_system.sql
-- Бонусный баланс клиента + журнал транзакций + заявки на вывод.
-- Этап 3 проекта оплаты подписки (после миграции 125 — реф-коды).
--
-- Источники начисления (через client_bonus_transactions.type):
--   accrual            — 10% от карточной оплаты подписки реферала (бэк-логика)
--   payment            — списание для оплаты собственной подписки бонусами
--   withdrawal_hold    — заморозка при заявке на вывод (минус с баланса)
--   withdrawal_done    — финализация вывода (информационная, не меняет баланс)
--   withdrawal_cancel  — возврат на баланс если заявку отклонили (плюс)
--   admin_adjust       — ручная корректировка от админа (может быть + или −)
--
-- Баланс хранится в копейках для точности (как amount_total_kopecks в subscription_orders).
-- client_bonus_balance — денормализованный кэш, источник правды — транзакции.

CREATE TABLE IF NOT EXISTS client_bonus_balance (
  client_id        INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  balance_kopecks  BIGINT NOT NULL DEFAULT 0 CHECK (balance_kopecks >= 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_bonus_transactions (
  id               SERIAL PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN (
                     'accrual',
                     'payment',
                     'withdrawal_hold',
                     'withdrawal_done',
                     'withdrawal_cancel',
                     'admin_adjust'
                   )),
  amount_kopecks   BIGINT NOT NULL,       -- знаковая: + начисление, − списание
  source_order_id  INTEGER NULL REFERENCES subscription_orders(id) ON DELETE SET NULL,
  source_payer_id  INTEGER NULL REFERENCES clients(id) ON DELETE SET NULL,  -- кто заплатил, чей кэшбэк
  withdrawal_id    INTEGER NULL,          -- ссылка на client_withdrawal_requests (без FK — цикл)
  description      TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_bonus_transactions_client_idx
  ON client_bonus_transactions (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_withdrawal_requests (
  id               SERIAL PRIMARY KEY,
  client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  amount_kopecks   BIGINT NOT NULL CHECK (amount_kopecks > 0),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  payment_details  TEXT NOT NULL,         -- реквизиты в свободной форме (карта/счёт/СБП)
  admin_note       TEXT NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS client_withdrawal_requests_status_idx
  ON client_withdrawal_requests (status, requested_at DESC);

-- Создаём пустые записи баланса для существующих клиентов
INSERT INTO client_bonus_balance (client_id, balance_kopecks)
SELECT id, 0 FROM clients
ON CONFLICT (client_id) DO NOTHING;

-- GRANTы для роли plusson (как в других миграциях)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plusson') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON client_bonus_balance, client_bonus_transactions, client_withdrawal_requests TO plusson';
    EXECUTE 'GRANT USAGE, SELECT ON client_bonus_transactions_id_seq, client_withdrawal_requests_id_seq TO plusson';
  END IF;
END $$;
