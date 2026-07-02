-- 188_leadpay_payment_fields.sql
-- Интеграция LeadPay (вторая платёжка, РЯДОМ с Prodamus — Prodamus не трогаем).
--
-- Способ подключения — API getLink (https://leadpay.gitbook.io/api/dokumentaciya/api):
--   1. Клиент жмёт «Оплатить» (provider=leadpay) → бэк создаёт заказ →
--      POST https://app.leadpay.ru/api/v1/getLink/ с параметрами:
--        login=LEADPAY_LOGIN, id=НАШ order_id, product_id=<из tariffs/features>,
--        count=1, notification_url=<наш webhook>, hash=HMAC-SHA256(ksort(значения), LEADPAY_TOKEN)
--      → получаем ссылку оплаты, редиректим клиента.
--   2. LeadPay при оплате шлёт POST на notification_url:
--        {status, summa, commission_sum, payable, order_id, hash [, card_id]}
--      → проверяем hash, находим заказ по order_id, выдаём подписку/модуль.
--
-- product_id — идентификатор карточки продукта в ЛК LeadPay. Марго создаёт по
-- карточке на каждый платный тариф/модуль и вписывает product_id в админку.
-- Токен и логин лендинга — в env (LEADPAY_TOKEN, LEADPAY_LOGIN), общие на клиента ПЛЮСОН.

-- Тарифы: id карточки LeadPay (getLink product_id).
ALTER TABLE tariffs
  ADD COLUMN IF NOT EXISTS leadpay_product_id TEXT NULL;

-- Модули-аддоны: id карточек LeadPay (помесячно и за 6 мес).
ALTER TABLE features
  ADD COLUMN IF NOT EXISTS leadpay_product_id     TEXT NULL,
  ADD COLUMN IF NOT EXISTS leadpay_product_id_6mo TEXT NULL;

-- Провайдер платежа на заказе — какой платёжкой создан заказ (для вебхука и аудита).
ALTER TABLE subscription_orders
  ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'prodamus'
    CHECK (payment_provider IN ('prodamus', 'leadpay'));
ALTER TABLE addon_orders
  ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'prodamus'
    CHECK (payment_provider IN ('prodamus', 'leadpay'));
