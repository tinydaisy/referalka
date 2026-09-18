-- 458: подзаголовок афиши тоже из ДВУХ частей разного цвета — как заголовок.
--
-- ⚠️ ЗАЧЕМ. У заголовка две части появились в миграции 447, и на макетах это
-- работает: «ВИДЕНИЕ/iViSiON-7:» белым, «БИЗНЕСЫ ВЛИЯНИЯ» золотом. В
-- подзаголовке та же потребность: часть текста выделяют цветом («…узнаваемость
-- и **проектирование будущего**»), а одним полем это не собрать.
--
-- ⚠️ Первая часть тоже получает СВОЙ цвет (`title_color` уже был, добавляем
-- явный `subtitle_color` — он есть; здесь только вторая часть и правило
-- переноса). Шрифт, кегль и подчёркивание общие: это ОДИН подзаголовок,
-- разбитый по цвету, а не два разных текста.

BEGIN;

ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS subtitle_2 TEXT,
  ADD COLUMN IF NOT EXISTS subtitle_2_color TEXT,
  ADD COLUMN IF NOT EXISTS subtitle_2_newline BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN event_poster_layouts.subtitle_2 IS
  'Вторая часть подзаголовка — своим цветом. Пусто = подзаголовок одноцветный';
COMMENT ON COLUMN event_poster_layouts.subtitle_2_color IS
  'Цвет второй части подзаголовка. Пусто = как у первой';
COMMENT ON COLUMN event_poster_layouts.subtitle_2_newline IS
  'Вторую часть — с новой строки (TRUE) или в подбор к первой (FALSE)';

-- ⚠️ Расстояния между текстовыми блоками. Были зашиты в код (пилюля → 1.6 %
-- ширины, заголовок → 1.2 %), и подвинуть их клиент не мог вовсе: на плотном
-- макете строки слипались, на просторном висели далеко друг от друга.
-- В ПИКСЕЛЯХ полотна — как и кегли (мигр. 457).
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS gap_pill_title NUMERIC(5,1) NOT NULL DEFAULT 18
      CHECK (gap_pill_title BETWEEN 0 AND 200),
  ADD COLUMN IF NOT EXISTS gap_title_subtitle NUMERIC(5,1) NOT NULL DEFAULT 14
      CHECK (gap_title_subtitle BETWEEN 0 AND 200);

COMMENT ON COLUMN event_poster_layouts.gap_pill_title IS
  'Отступ от пилюли до заголовка, px полотна';
COMMENT ON COLUMN event_poster_layouts.gap_title_subtitle IS
  'Отступ от заголовка до подзаголовка, px полотна';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
