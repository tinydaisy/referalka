-- 454: раскладка афиши в КОЛОНКИ — текст и спикеры рядом, а не друг под другом.
--
-- ⚠️ ЗАЧЕМ. Раскладка была одна: логотипы сверху, под ними текст, под ним
-- спикеры. На горизонтальной афише это оставляет спикерам узкую полосу внизу,
-- хотя по бокам полно места. Требование владельца (18.09.2026): уметь ставить
-- весь текст слева или справа, а спикеров — рядом, во вторую колонку.
--
-- `speakers_side` (не путать с отменённым боковым полем из 440):
--   full  — как было: текст сверху во всю ширину, спикеры под ним;
--   left  — спикеры слева, текст справа;
--   right — спикеры справа, текст слева.
--
-- ⚠️ ВЫРАВНИВАНИЕ ОТДЕЛЬНО У ТЕКСТА И ЛОГОТИПОВ. В колонке текст может стоять
-- по центру, а логотипы прижиматься к краю — это разные решения, и один общий
-- переключатель заставил бы выбирать.
-- Для заголовка и подзаголовка выравнивание уже есть (`title_align`,
-- `subtitle_align`), здесь добавляем общее для БЛОКА и для логотипов.

BEGIN;

ALTER TABLE event_poster_layouts
  -- Где стоят спикеры относительно текста.
  ADD COLUMN IF NOT EXISTS layout_mode TEXT NOT NULL DEFAULT 'full'
      CHECK (layout_mode IN ('full', 'left', 'right')),
  -- Какую долю ширины занимает колонка спикеров (при left/right).
  ADD COLUMN IF NOT EXISTS speakers_width INTEGER NOT NULL DEFAULT 55
      CHECK (speakers_width BETWEEN 25 AND 80),
  -- Выравнивание текстового блока внутри своей колонки.
  ADD COLUMN IF NOT EXISTS text_align TEXT NOT NULL DEFAULT 'center'
      CHECK (text_align IN ('left', 'center', 'right'));

COMMENT ON COLUMN event_poster_layouts.layout_mode IS
  'Раскладка: full — текст сверху во всю ширину; left/right — спикеры слева/справа, текст рядом';
COMMENT ON COLUMN event_poster_layouts.speakers_width IS
  'Доля ширины под колонку спикеров при layout_mode = left/right, %';
COMMENT ON COLUMN event_poster_layouts.text_align IS
  'Выравнивание текстового блока в своей колонке';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
