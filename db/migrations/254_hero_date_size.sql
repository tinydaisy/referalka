-- 254: Размер даты в шапке лендинга (миграции 240-253).
--
-- Дата события выводится в блоке «Шапка» над заголовком или под описанием
-- (поля show_date / date_position, миграция 247), но размер у неё был
-- жёстко наследованный от основного текста — задать покрупнее было нечем.

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS date_size INT;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
