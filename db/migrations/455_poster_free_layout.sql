-- 455: каждый блок афиши двигается сам — X, Y и ширина.
--
-- ⚠️ ЗАЧЕМ. Раскладка была жёсткой: логотипы сверху, под ними текст, под ним
-- спикеры. Потом добавили режим колонок (454), но и он не покрывает всё:
-- клиент хочет то текст слева, то логотипы столбиком у края, то спикеров
-- прижать к низу. Каждый такой случай — это новая настройка, и список рос бы
-- бесконечно.
--
-- Проще дать три блока свободно: у каждого своё положение и ширина. Тогда
-- любая раскладка собирается ползунками, а не новым полем в базе.
--
-- Всё в ПРОЦЕНТАХ рабочей области: 0 — левый/верхний край, 100 — правый/нижний.
--
-- ⚠️ `layout_mode` из 454 ОСТАЁТСЯ как быстрый пресет: «текст сверху»,
-- «спикеры слева», «спикеры справа» — он просто выставляет эти координаты
-- разом. Клиенту не надо возить три ползунка, чтобы получить типовой вид.

BEGIN;

ALTER TABLE event_poster_layouts
  -- Логотипы.
  ADD COLUMN IF NOT EXISTS logos_x INTEGER NOT NULL DEFAULT 0
      CHECK (logos_x BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS logos_w INTEGER NOT NULL DEFAULT 100
      CHECK (logos_w BETWEEN 10 AND 100),
  -- Как выстроены логотипы между собой.
  ADD COLUMN IF NOT EXISTS logos_dir TEXT NOT NULL DEFAULT 'row'
      CHECK (logos_dir IN ('row', 'column', 'grid')),

  -- Текстовый блок.
  ADD COLUMN IF NOT EXISTS text_x INTEGER NOT NULL DEFAULT 0
      CHECK (text_x BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS text_w INTEGER NOT NULL DEFAULT 100
      CHECK (text_w BETWEEN 10 AND 100),

  -- Блок спикеров: X и ширина (Y уже есть — speakers_top/bottom).
  ADD COLUMN IF NOT EXISTS speakers_x INTEGER NOT NULL DEFAULT 0
      CHECK (speakers_x BETWEEN 0 AND 100);

COMMENT ON COLUMN event_poster_layouts.logos_x IS
  'Левый край блока логотипов, % рабочей области';
COMMENT ON COLUMN event_poster_layouts.logos_w IS
  'Ширина блока логотипов, % рабочей области';
COMMENT ON COLUMN event_poster_layouts.logos_dir IS
  'Как выстроены логотипы: row — в ряд, column — в столбик, grid — сеткой с переносом';
COMMENT ON COLUMN event_poster_layouts.text_x IS
  'Левый край текстового блока, % рабочей области';
COMMENT ON COLUMN event_poster_layouts.text_w IS
  'Ширина текстового блока, % рабочей области';
COMMENT ON COLUMN event_poster_layouts.speakers_x IS
  'Левый край блока спикеров, % рабочей области';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
