-- 223. Вебинарная комната: сколько продающих кнопок выводить в один ряд.
--
-- ЗАЧЕМ. Кнопки-офферы шли столбиком по одной. Нужна раскладка «N в ряд»
-- (1 = столбик, 2 = попарно и т.д.) — настраивается на комнату дня.
-- Заголовок над блоком-кнопкой в UI больше не выводим (дублировал текст кнопки),
-- это правка фронта, поле в БД не требуется.

BEGIN;

ALTER TABLE webinar_rooms
  ADD COLUMN IF NOT EXISTS buttons_per_row INTEGER NOT NULL DEFAULT 1;

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_rooms TO plusson;

COMMIT;
