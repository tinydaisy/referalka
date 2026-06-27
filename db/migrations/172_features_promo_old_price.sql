-- Миграция 172: акционная (зачёркнутая) старая цена у модулей-аддонов.
--
-- У тарифов уже была promo_old_price (миграция 116). У модулей (features) её не было —
-- можно было только снизить цену без «старая → новая». Добавляем такую же возможность.
--
-- promo_old_monthly — старая цена/мес для зачёркивания (когда идёт акция).
-- promo_old_6mo     — старая цена/мес при оплате за 6 мес для зачёркивания.
-- Реальная (платимая) цена остаётся в price_monthly / price_6mo.
--
-- Сразу запускаем акцию по «Коллабораторной»: 1000 ₽ вместо 2000 ₽ (мес),
-- 800 ₽ вместо 1600 ₽ (за 6 мес).

ALTER TABLE features
  ADD COLUMN IF NOT EXISTS promo_old_monthly INTEGER NULL,
  ADD COLUMN IF NOT EXISTS promo_old_6mo     INTEGER NULL;

-- Акция «Коллабораторная»: новая цена дешевле, старая — зачёркнута.
UPDATE features
   SET price_monthly     = 1000,
       price_6mo         = 800,
       promo_old_monthly = 2000,
       promo_old_6mo     = 1600
 WHERE slug = 'collab_hub';
