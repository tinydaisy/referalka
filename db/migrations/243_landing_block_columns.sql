-- 243: Колонки в сетке карточек + счётчик мест в шапке (миграции 240-242).
--
-- columns      — сколько карточек в ряд (спикеры, ценности, отличия, галерея).
--                На узких экранах колонок всё равно меньше — сетка адаптивная,
--                это верхняя граница для широкого экрана.
-- show_seats   — показывать «осталось мест» прямо в шапке рядом с кнопкой.
--                Отдельная секция `seats` при этом обычно не нужна.
-- seats_position — где именно: над кнопкой (above) или сбоку от неё (side).

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS columns        SMALLINT NOT NULL DEFAULT 3
        CHECK (columns BETWEEN 1 AND 6),
  ADD COLUMN IF NOT EXISTS show_seats     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS seats_position TEXT NOT NULL DEFAULT 'above'
        CHECK (seats_position IN ('above', 'side'));

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;

-- ─────────────────────────────────────────────────────────────────────────────
-- Режим градиента фона
-- ─────────────────────────────────────────────────────────────────────────────
-- Растянутый на всю страницу градиент выглядит плохо: вверху виден только один
-- край, внизу другой, а сам переход «размазан» и не читается. Режимы:
--   page   — на всю высоту страницы (как было, для коротких лендингов)
--   screen — повторяется на каждом экране (по умолчанию: переход виден везде)
--   block  — свой градиент у каждой секции
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_bg_mode TEXT DEFAULT 'screen';

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS bg_mode TEXT NOT NULL DEFAULT 'screen'
        CHECK (bg_mode IN ('page', 'screen', 'block'));

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;

-- ─────────────────────────────────────────────────────────────────────────────
-- Размер заголовка секции
-- ─────────────────────────────────────────────────────────────────────────────
-- Размер был захардкожен, а он нужен разный: у шапки крупный, у мелких секций
-- скромнее. Значение — размер на широком экране в px; на телефоне уменьшается
-- пропорционально (через clamp в рендере), чтобы длинное слово не вылезало.
-- NULL = размер по умолчанию (48 у обычной секции, 72 у шапки).
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS title_size SMALLINT
        CHECK (title_size IS NULL OR title_size BETWEEN 16 AND 140),
  -- Выравнивание заголовка секции: по левому краю / по центру / по правому.
  ADD COLUMN IF NOT EXISTS title_align TEXT NOT NULL DEFAULT 'left'
        CHECK (title_align IN ('left', 'center', 'right'));

-- Размер основного текста на странице целиком (px). Дефолт 16.
ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS body_size SMALLINT NOT NULL DEFAULT 16
        CHECK (body_size BETWEEN 12 AND 28);

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_body_size SMALLINT DEFAULT 16;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages  TO plusson;
