-- 257: Платёжная система КЛИЕНТА + оплата тарифов события (миграции 240-256).
--
-- ⚠️ Не путать с ключами ПЛЮСОНа. Существующие LEADPAY_LOGIN/LEADPAY_TOKEN в
-- переменных окружения — наши, ими оплачивают подписку на платформу. Здесь
-- ключи КАЖДОГО клиента: ими его покупатели оплачивают тарифы его событий,
-- деньги идут ему.
--
-- Подключено (есть логин и ключ) → в тарифе указывается код товара, ссылку
-- оплаты создаём сами через API и ловим оплату вебхуком.
-- Не подключено → в тарифе внешняя ссылка на оплату, как раньше; оплаты
-- отмечаются вручную.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS pay_provider      TEXT,   -- 'leadpay' | NULL
  ADD COLUMN IF NOT EXISTS pay_leadpay_login TEXT,   -- адрес лендинга в LeadPay
  ADD COLUMN IF NOT EXISTS pay_leadpay_token TEXT;   -- секретный ключ

-- Код товара в платёжной системе. pay_url остаётся для внешних ссылок.
ALTER TABLE event_tariffs
  ADD COLUMN IF NOT EXISTS pay_product_id TEXT;

-- Заказ на тариф: связь с платёжной системой и кто заказал.
-- ⚠️ participant_id уже есть, но при заказе участника может ещё не быть —
-- сначала контакт, потом оплата. Поэтому contact_id отдельно.
ALTER TABLE event_participant_tariffs
  ADD COLUMN IF NOT EXISTS contact_id      INT REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_url     TEXT,
  ADD COLUMN IF NOT EXISTS payment_provider TEXT;

-- participant_id теперь необязателен: заказ создаётся до регистрации.
ALTER TABLE event_participant_tariffs
  ALTER COLUMN participant_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ept_contact ON event_participant_tariffs (contact_id);

-- Фича «Платежи» — пока только админский тариф.
INSERT INTO features (slug, name, description)
VALUES ('payments', 'Платежи',
        'Приём оплаты за тарифы событий через свою платёжную систему')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'payments'
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_participant_tariffs TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_tariffs TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO plusson;
