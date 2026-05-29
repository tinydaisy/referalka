-- 119_promotions.sql
-- Таблица акций ПЛЮСОНа. Пока единственный тип — `trial_bonus_days`
-- (продлевает trial-период первым N клиентам). Тип задуман расширяемым:
-- в будущем могут появиться `signup_bonus_kopecks` и т.п. для других сценариев.
--
-- Скидки на оплату через эту таблицу НЕ применяются — для них клиент
-- вручную подменяет URL платёжной формы Prodamus в /admin/tariffs
-- (см. tariffs.prodamus_payment_url + promo_banner_text + promo_old_price).

CREATE TABLE IF NOT EXISTS promotions (
  id                  SERIAL PRIMARY KEY,
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NULL,
  type                TEXT NOT NULL CHECK (type IN ('trial_bonus_days')),
  value               INTEGER NOT NULL,
  target_tariff_slug  TEXT NULL,
  max_uses            INTEGER NULL,
  used_count          INTEGER NOT NULL DEFAULT 0,
  starts_at           TIMESTAMPTZ NULL,
  ends_at             TIMESTAMPTZ NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS promotions_active_idx ON promotions (is_active, type)
  WHERE is_active = TRUE;

-- Seed: «Первым 30 клиентам — 2 месяца в подарок».
-- Базовый trial 14 дней + 46 дней по акции = 60 дней.
INSERT INTO promotions (slug, name, description, type, value, target_tariff_slug, max_uses, is_active)
VALUES (
  'first_30_trial_bonus',
  'Первым 30 клиентам — 2 месяца trial в подарок',
  'Каждому из первых 30 зарегистрированных клиентов trial-период увеличивается с 14 до 60 дней.',
  'trial_bonus_days',
  46,
  'trial',
  30,
  TRUE
)
ON CONFLICT (slug) DO NOTHING;

-- GRANTы (роль на dev/prod = plusson)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plusson') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON promotions TO plusson';
    EXECUTE 'GRANT USAGE, SELECT ON promotions_id_seq TO plusson';
  END IF;
END $$;
