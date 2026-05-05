-- 061: Удаляем избыточные VIP-поля у events.
-- Бизнес-логика свелась к одному факту: «есть ли ссылка на оплату VIP».
-- Поэтому оставляем только vip_url. Текст кнопки в Mini App статичный
-- («Расшириться до VIP-тарифа» в программе, «Купить VIP-тариф с записями» в итогах).

ALTER TABLE events
  DROP COLUMN IF EXISTS has_vip_tariff,
  DROP COLUMN IF EXISTS vip_title,
  DROP COLUMN IF EXISTS vip_price,
  DROP COLUMN IF EXISTS vip_description;
