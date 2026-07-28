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

-- Картинку секции можно поставить по центру (под текстом, во всю ширину
-- колонки) — раньше были только слева/справа/сверху/снизу.
ALTER TABLE event_landing_blocks DROP CONSTRAINT IF EXISTS event_landing_blocks_image_position_check;
ALTER TABLE event_landing_blocks
  ADD CONSTRAINT event_landing_blocks_image_position_check
  CHECK (image_position IN ('left', 'right', 'top', 'bottom', 'center'));

-- Ширина картинки секции в % от колонки (100 = во всю ширину).
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS image_width SMALLINT NOT NULL DEFAULT 100
        CHECK (image_width BETWEEN 20 AND 100);

-- Стиль карточек секции: рамка вокруг каждой / тонкая линия-разделитель снизу /
-- совсем без оформления. Булев `cards_bordered` оставлен для совместимости —
-- новый код читает `card_style`.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS card_style TEXT NOT NULL DEFAULT 'border'
        CHECK (card_style IN ('border', 'divider', 'plain'));

-- Переносим уже снятые рамки в новое поле.
UPDATE event_landing_blocks SET card_style = 'plain' WHERE cards_bordered = FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
