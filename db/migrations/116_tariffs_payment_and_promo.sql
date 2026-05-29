-- 116_tariffs_payment_and_promo.sql
-- Расширение tariffs полями для приёма оплаты через Prodamus и отображения акций.
--
-- Контекст:
--   1) Для каждого платного тарифа клиент копирует из Prodamus URL платёжной формы
--      и вставляет в `prodamus_payment_url`. Скидки делаются ручной подменой URL
--      (создаётся новая ссылка в Prodamus с другой ценой) — не через query-параметры.
--   2) `promo_banner_text` — короткая надпись для лендинга/дашборда («-30% до 31.12»).
--   3) `promo_old_price` — старая цена для зачёркивания на лендинге (когда идёт акция).
--   4) Базовый trial меняем с 60 → 14 дней. Текущая «60 дней» уезжает в отдельную
--      промоакцию «Первым 30 клиентам — 2 месяца в подарок» (миграция 119).

ALTER TABLE tariffs
  ADD COLUMN IF NOT EXISTS prodamus_payment_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS promo_banner_text    TEXT NULL,
  ADD COLUMN IF NOT EXISTS promo_old_price      NUMERIC(10,2) NULL;

-- Сидим текущие ссылки клиента
UPDATE tariffs SET prodamus_payment_url = 'https://payform.ru/n0bBHqn/' WHERE slug = 'start';
UPDATE tariffs SET prodamus_payment_url = 'https://payform.ru/q8bBHs6/' WHERE slug = 'pro';
UPDATE tariffs SET prodamus_payment_url = 'https://payform.ru/rrbBHsW/' WHERE slug = 'vip';

-- Базовый trial = 14 дней (текущее значение 60 переезжает в promotions с миграции 119)
UPDATE tariffs SET default_duration_days = 14 WHERE slug = 'trial';
