-- 470: на афише спикера каждый элемент стоит САМ ПО СЕБЕ, а не в колонке.
--
-- ⚠️⚠️ ЗАЧЕМ. Элементы индивидуальной афиши (название, роль, имя, тема, время,
-- фото) лежали в ОДНОЙ колонке, которая позиционировалась по `ind_photo_x/y` —
-- то есть по фото. Рычаги из миграции 468 двигали элемент ВНУТРИ этой колонки,
-- и дальше её границ он уйти не мог: «почему низ темы не доходит до низа
-- афиши? как-то привязано к положению фото спикера» (владелец, 20.09.2026).
-- Владелец прав: привязка была, и она мешала.
--
-- Решение: у каждого элемента своя точка на листе, в процентах РАБОЧЕЙ ОБЛАСТИ
-- (миграция 440) — как у всего остального на афише. Пиксельные сдвиги из 468
-- продолжают работать поверх: точка задаёт грубое место, сдвиг — доводку.
--
-- ⚠️ NULL = «как раньше», элемент остаётся в общей колонке. Иначе собранные
-- афиши разъехались бы в момент наката: у них ни одна точка не задана, и все
-- элементы схлопнулись бы в левый верхний угол.
--
-- Порядок применения в коде:
--   точка задана  → элемент абсолютный, стоит где сказано;
--   точки нет     → элемент в колонке, как до этой миграции.

BEGIN;

ALTER TABLE event_poster_layouts
  -- Название конференции.
  ADD COLUMN IF NOT EXISTS ind_title_x NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS ind_title_y NUMERIC(5,1),
  -- Роль спикера.
  ADD COLUMN IF NOT EXISTS ind_role_x NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS ind_role_y NUMERIC(5,1),
  -- Имя и фамилия.
  ADD COLUMN IF NOT EXISTS ind_name_x NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS ind_name_y NUMERIC(5,1),
  -- Тема выступления.
  ADD COLUMN IF NOT EXISTS ind_topic_x NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS ind_topic_y NUMERIC(5,1),
  -- Время выступления.
  ADD COLUMN IF NOT EXISTS ind_time_x NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS ind_time_y NUMERIC(5,1);

-- ⚠️ Ширина текстового элемента: длинная тема в одну строку уехала бы за поля.
-- Доля ширины рабочей области; пусто — 80 %, как у колонки сейчас.
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_topic_w NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS ind_name_w NUMERIC(5,1);

COMMENT ON COLUMN event_poster_layouts.ind_topic_x IS
  'Тема выступления: своя точка на листе, % ширины рабочей области. '
  'NULL — элемент стоит в общей колонке под фото (поведение до миграции 470)';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
