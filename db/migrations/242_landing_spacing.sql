-- 242: Отступы и ширина контента лендинга (миграции 240, 241).
--
-- Зачем. Ширина полосы контента и боковые поля были захардкожены — на широком
-- экране текст расползался, а на узком упирался в края. Теперь клиент задаёт:
--   content_width  — максимальная ширина полосы контента, px (0 = во всю ширину)
--   pad_x          — боковые отступы, px (на мобильном не меньше 16)
--   section_gap    — вертикальный отступ между секциями, px
--
-- Как и остальное оформление: дефолт берётся из темы клиента (clients.lp_*),
-- у секции можно переопределить свой отступ (event_landing_blocks.pad_y).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_content_width SMALLINT DEFAULT 1120,
  ADD COLUMN IF NOT EXISTS lp_pad_x         SMALLINT DEFAULT 24,
  ADD COLUMN IF NOT EXISTS lp_section_gap   SMALLINT DEFAULT 64;

COMMENT ON COLUMN clients.lp_content_width IS
  'Максимальная ширина контента лендинга в px. 0 = на всю ширину экрана.';

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS content_width SMALLINT NOT NULL DEFAULT 1120
        CHECK (content_width = 0 OR content_width BETWEEN 480 AND 2000),
  ADD COLUMN IF NOT EXISTS pad_x         SMALLINT NOT NULL DEFAULT 24
        CHECK (pad_x BETWEEN 0 AND 160),
  ADD COLUMN IF NOT EXISTS section_gap   SMALLINT NOT NULL DEFAULT 64
        CHECK (section_gap BETWEEN 0 AND 200);

-- Своя вертикальная «воздушность» секции; NULL = как у страницы.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS pad_y SMALLINT
        CHECK (pad_y IS NULL OR pad_y BETWEEN 0 AND 200);

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages  TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
