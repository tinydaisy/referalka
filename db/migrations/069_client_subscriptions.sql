-- 069_client_subscriptions.sql (07.05.2026)
-- Подписка клиента на тариф. Один клиент = одна активная подписка.
-- История сохраняется (всё клиент-тариф связи живут здесь, старые с expires_at в прошлом).
-- Сидинг — в миграции 072.
--
-- Статусы:
--   active   — текущая, expires_at > NOW()
--   expired  — истекла, не продлена. UI становится read-only, рассылки паузятся.
--   paused   — приостановлена админом (на будущее, для recoverable freeze).
--
-- Source — источник подписки:
--   paid     — оплачена клиентом
--   trial    — пробная при регистрации
--   admin    — выдана администратором вручную (для системного клиента, дев-аккаунтов)
--   promo    — по промокоду (на будущее)

BEGIN;

CREATE TABLE IF NOT EXISTS client_subscriptions (
  id           SERIAL PRIMARY KEY,
  client_id    INTEGER     NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tariff_id    INTEGER     NOT NULL REFERENCES tariffs(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'expired', 'paused')),
  source       TEXT        NOT NULL DEFAULT 'paid'
                 CHECK (source IN ('paid', 'trial', 'admin', 'promo')),
  notified_7d  BOOLEAN     NOT NULL DEFAULT FALSE,
  notified_3d  BOOLEAN     NOT NULL DEFAULT FALSE,
  notified_1d  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_subs_client_expires
  ON client_subscriptions(client_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_subs_status
  ON client_subscriptions(status);

COMMIT;
