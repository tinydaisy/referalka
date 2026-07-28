-- 245: Размеры текста внутри секции лендинга (миграции 240-244).
--
-- Зачем. Размер настраивался только у заголовка секции и у основного текста
-- страницы целиком. Подзаголовок и содержимое конкретной секции (пункты
-- списка, названия подарков, карточки) были фиксированы — например, подарки
-- нельзя было сделать крупнее, чем остальной текст.
--
--   subtitle_size — размер подзаголовка секции, px
--   text_size     — размер содержимого секции (списки, карточки, подарки,
--                   тарифы, программа), px. NULL = как у страницы (body_size).

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS subtitle_size SMALLINT
        CHECK (subtitle_size IS NULL OR subtitle_size BETWEEN 10 AND 64),
  ADD COLUMN IF NOT EXISTS text_size     SMALLINT
        CHECK (text_size IS NULL OR text_size BETWEEN 10 AND 48);

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
