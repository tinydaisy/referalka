-- Миграция 197: комплект «тариф Профи + модуль» одной оплатой (LeadPay bundle-карточки)
--
-- Клиент без нужного тарифа видит под модулем кнопку «Профи + модуль за N ₽» и
-- покупает и тариф Профи, и модуль ОДНИМ платежом по отдельной карточке LeadPay.
--
-- features.leadpay_bundle_pro_product_id — id карточки LeadPay «Профи + этот модуль»
--   (напр. 62862 = Профи+Коллабораторная, 62863 = Профи+Конференции, 62864 = Профи+Турниры).
-- addon_orders.bundle_with_pro — этот заказ куплен как комплект → при выдаче
--   дополнительно активируем тариф Профи, не только модуль.

ALTER TABLE features
    ADD COLUMN IF NOT EXISTS leadpay_bundle_pro_product_id TEXT;

ALTER TABLE addon_orders
    ADD COLUMN IF NOT EXISTS bundle_with_pro BOOLEAN NOT NULL DEFAULT FALSE;

-- Привязка bundle-карточек к модулям (id из LeadPay-кабинета клиента).
UPDATE features SET leadpay_bundle_pro_product_id = '62862' WHERE slug = 'collab_hub';
UPDATE features SET leadpay_bundle_pro_product_id = '62863' WHERE slug = 'conference';
UPDATE features SET leadpay_bundle_pro_product_id = '62864' WHERE slug = 'tournaments';
