-- 244: Переопределение оформления у отдельной секции (миграции 240-243).
--
-- Зачем. Стиль темы един на всю страницу, но отдельным секциям нужен свой вид:
-- цифры красивее без рамок, а заголовок иногда должен быть белым, а не
-- фирменным персиковым. Раньше пришлось бы менять тему целиком.
--
--   cards_bordered — рисовать рамку у карточек секции (по умолчанию TRUE,
--                    как было; снять — карточки «висят» без рамки и фона)
--   title_color    — свой цвет заголовка секции (NULL = цвет из темы)
--   title_metallic — металлический перелив у заголовка секции
--                    (NULL = как задано в теме)

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS cards_bordered BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS title_color    TEXT,
  ADD COLUMN IF NOT EXISTS title_metallic BOOLEAN;

-- Цифрам рамка не нужна — они и так читаются крупным металликом.
-- Правим только существующие блоки; у новых дефолт остаётся TRUE.
UPDATE event_landing_blocks SET cards_bordered = FALSE WHERE kind = 'numbers';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
