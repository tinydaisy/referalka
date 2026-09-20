-- 468: УНИВЕРСАЛЬНОЕ положение каждого блока афиши + выключка текста.
--
-- ⚠️⚠️ ЗАЧЕМ. До сих пор у каждого блока была своя отдельная настройка (или не
-- было вовсе): у логотипов `partners_y`, у текста `text_top`, у спикеров
-- `speakers_top`, у пилюли дня — ничего, у темы и времени на афише спикера —
-- ничего. Клиент просил одного и того же для всех: «универсальные рычаги
-- управления положением относительно лева/права и вверх/вниз — для каждого
-- блока элементов» (владелец, 19.09.2026).
--
-- Блоки, которые двигаются НЕЗАВИСИМО:
--   logos    — логотип бренда и партнёры (один ряд, миграция 446);
--   text     — заголовок с подзаголовком;
--   pill1    — первая пилюля (дата / день) — ОТДЕЛЬНО от второй;
--   pill2    — вторая пилюля (формат: «Онлайн-конференция»);
--   speakers — сетка спикеров;
--   photo    — фото на индивидуальной афише;
--   topic    — тема выступления (индивидуальная);
--   time     — время выступления (индивидуальная).
--
-- ⚠️ ПОЛОЖЕНИЕ В ПИКСЕЛЯХ ПОЛОТНА, а не в процентах (требование владельца:
-- «положения надо попиксельно»). Проценты пересчитывались при каждом изменении
-- полей, и блок уезжал сам собой; пиксель — величина, которую видно глазом и
-- можно вписать числом. Отсчёт от левого верхнего угла РАБОЧЕЙ ОБЛАСТИ
-- (миграция 440): за поля по-прежнему не выходит ничего.
--
-- ⚠️ NULL = «как раньше», по старым настройкам блока. Так уже собранные афиши
-- не поедут: пока клиент не трогал рычаг, ничего не меняется.
--
-- Выключка (`*_align`) — у всего, что является текстом: left / center / right.

BEGIN;

ALTER TABLE event_poster_layouts
  -- Логотипы.
  ADD COLUMN IF NOT EXISTS pos_logos_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_logos_y INTEGER,
  -- Заголовок с подзаголовком.
  ADD COLUMN IF NOT EXISTS pos_text_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_text_y INTEGER,
  -- Пилюли — каждая сама по себе.
  ADD COLUMN IF NOT EXISTS pos_pill1_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_pill1_y INTEGER,
  ADD COLUMN IF NOT EXISTS pos_pill2_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_pill2_y INTEGER,
  -- Сетка спикеров.
  ADD COLUMN IF NOT EXISTS pos_speakers_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_speakers_y INTEGER,
  -- Индивидуальная афиша: фото, тема, время.
  ADD COLUMN IF NOT EXISTS pos_photo_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_photo_y INTEGER,
  ADD COLUMN IF NOT EXISTS pos_topic_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_topic_y INTEGER,
  ADD COLUMN IF NOT EXISTS pos_time_x INTEGER,
  ADD COLUMN IF NOT EXISTS pos_time_y INTEGER;

-- Выключка текстовых блоков.
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS pill1_align TEXT NOT NULL DEFAULT 'center'
      CHECK (pill1_align IN ('left', 'center', 'right')),
  ADD COLUMN IF NOT EXISTS pill2_align TEXT NOT NULL DEFAULT 'center'
      CHECK (pill2_align IN ('left', 'center', 'right')),
  ADD COLUMN IF NOT EXISTS topic_align TEXT NOT NULL DEFAULT 'center'
      CHECK (topic_align IN ('left', 'center', 'right')),
  ADD COLUMN IF NOT EXISTS time_align TEXT NOT NULL DEFAULT 'center'
      CHECK (time_align IN ('left', 'center', 'right')),
  ADD COLUMN IF NOT EXISTS name_align TEXT NOT NULL DEFAULT 'center'
      CHECK (name_align IN ('left', 'center', 'right'));

-- ⚠️⚠️ ПОТОЛОК РАЗМЕРА КАРТОЧКИ. При одном человеке в ряду ширина карточки
-- считалась как «вся строка делённая на одного» — то есть 100 %, и карточка
-- раздувалась на пол-листа. На афише дня, где выступает только организатор,
-- это выглядело сломанным, а уменьшить было нечем: ползунок задаёт число
-- рядов, а не размер. Умолчание 30 % — примерно как в ряду из трёх человек.
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS card_max_w NUMERIC(5,1) NOT NULL DEFAULT 30
      CHECK (card_max_w BETWEEN 5 AND 100);

COMMENT ON COLUMN event_poster_layouts.card_max_w IS
  'Потолок ширины карточки спикера, % колонки. Не даёт карточке раздуться, '
  'когда человек в ряду один';

-- ⚠️ На индивидуальной афише текст может стоять НАД фото, а не только под ним
-- («хочу над фото — хочу под фото», владелец). Порядок задаётся явно, а не
-- выводится из координат: так понятнее и не зависит от того, что куда сдвинули.
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_photo_first BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN event_poster_layouts.pos_logos_x IS
  'Сдвиг блока логотипов по горизонтали, ПИКСЕЛИ полотна от левого края '
  'рабочей области. NULL — прежнее поведение (по своим старым настройкам)';
COMMENT ON COLUMN event_poster_layouts.ind_photo_first IS
  'На афише спикера: TRUE — фото сверху, текст под ним; FALSE — текст сверху '
  '(порядок из ТЗ: пилюля, название, роль, имя, тема, время, а потом фото)';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
