-- 305: Скидка у тарифов события и продукта
--
-- Зачем. Клиент продаёт тариф со скидкой и хочет показать это на лендинге:
-- старая цена зачёркнута, рядом новая. Раньше приходилось руками писать
-- «было 5000» в описании — текстом, мимо вёрстки и без пересчёта.
--
-- ⚠️ Храним РАЗМЕР СКИДКИ, а не старую цену. Так «−20%» остаётся верным
-- при смене цены; старая цена вычисляется. Обратный вариант (хранить
-- old_price) при каждой правке цены пришлось бы пересчитывать руками,
-- и он молча разъезжался бы с реальностью.
--
-- ⚠️ `price` остаётся ЦЕНОЙ К ОПЛАТЕ (со скидкой) — именно она уходит
-- в платёжку и в amount заказа. Старая цена нужна только для показа,
-- иначе человек увидел бы на лендинге одну сумму, а в платёжке другую.

-- discount_kind: NULL = скидки нет (по умолчанию, существующие не тронуты)
--                'percent' = процент от старой цены
--                'amount'  = скидка в рублях
ALTER TABLE event_tariffs
  ADD COLUMN IF NOT EXISTS discount_kind  TEXT,
  ADD COLUMN IF NOT EXISTS discount_value INTEGER;

ALTER TABLE product_tariffs
  ADD COLUMN IF NOT EXISTS discount_kind  TEXT,
  ADD COLUMN IF NOT EXISTS discount_value INTEGER;

-- Значение без вида (и наоборот) — бессмыслица: непонятно, рубли это или
-- проценты. CHECK держит пару целой.
--
-- ⚠️ Ветки обёрнуты в COALESCE(..., FALSE). Без этого пара
-- (kind='percent', value=NULL) давала бы NULL, а НЕ FALSE — и CHECK пропускал
-- бы её: в SQL любое сравнение с NULL неизвестно, а неизвестность ограничение
-- считает выполненной. Проверено на проде: такая строка проходила.
ALTER TABLE event_tariffs
  DROP CONSTRAINT IF EXISTS event_tariffs_discount_chk;
ALTER TABLE event_tariffs
  ADD CONSTRAINT event_tariffs_discount_chk CHECK (
    (discount_kind IS NULL AND discount_value IS NULL)
    OR COALESCE(discount_kind = 'percent' AND discount_value > 0 AND discount_value < 100, FALSE)
    OR COALESCE(discount_kind = 'amount'  AND discount_value > 0, FALSE)
  );

ALTER TABLE product_tariffs
  DROP CONSTRAINT IF EXISTS product_tariffs_discount_chk;
ALTER TABLE product_tariffs
  ADD CONSTRAINT product_tariffs_discount_chk CHECK (
    (discount_kind IS NULL AND discount_value IS NULL)
    OR COALESCE(discount_kind = 'percent' AND discount_value > 0 AND discount_value < 100, FALSE)
    OR COALESCE(discount_kind = 'amount'  AND discount_value > 0, FALSE)
  );

COMMENT ON COLUMN event_tariffs.discount_kind IS
  'percent|amount|NULL. NULL = скидки нет. price — цена К ОПЛАТЕ (со скидкой).';
COMMENT ON COLUMN event_tariffs.discount_value IS
  'Размер скидки: проценты (1..99) или рубли. Старая цена вычисляется.';
COMMENT ON COLUMN product_tariffs.discount_kind IS
  'percent|amount|NULL. NULL = скидки нет. price — цена К ОПЛАТЕ (со скидкой).';
COMMENT ON COLUMN product_tariffs.discount_value IS
  'Размер скидки: проценты (1..99) или рубли. Старая цена вычисляется.';
