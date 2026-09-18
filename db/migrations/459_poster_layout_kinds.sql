-- 459: генератор афиш — ТРИ ВИДА макета: общая, по дням, индивидуальная.
--
-- ⚠️ ЗАЧЕМ. До сих пор макет был один на событие и ориентацию — общая афиша со
-- всеми спикерами. Нужны ещё два вида (требование владельца 18.09.2026):
--   day        — афиша ДНЯ: только спикеры этого дня, в пилюле «День 1 — 24.09
--                в 11:00», подзаголовка нет;
--   individual — афиша ОДНОГО спикера: роль, имя, тема выступления, время.
--
-- ⚠️ НАСТРОЙКИ У КАЖДОГО ВИДА СВОИ (решение владельца). Задачи разные: на общей
-- четырнадцать лиц мелкой сеткой, на индивидуальной одно крупное фото. Общие
-- настройки пришлось бы перекраивать при каждом переключении — и любая правка
-- одного вида ломала бы два других.
--
-- Ключ уникальности становится тройным: (event_id, kind, orientation).

BEGIN;

ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'common'
      CHECK (kind IN ('common', 'day', 'individual'));

-- ⚠️ Старый уникальный индекс держал одну строку на (event_id, orientation) —
-- с тремя видами это ровно одна строка вместо трёх. Заменяем.
DROP INDEX IF EXISTS uq_event_poster_layouts;
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_poster_layouts
    ON event_poster_layouts (event_id, kind, orientation);

COMMENT ON COLUMN event_poster_layouts.kind IS
  'Вид макета: common — общая афиша, day — афиша дня, individual — афиша спикера';

-- Настройки, нужные только афише СПИКЕРА. У общей и дневной их нет: там нет
-- ни темы выступления, ни одного конкретного человека.
ALTER TABLE event_poster_layouts
  -- Что показывать на индивидуальной афише.
  ADD COLUMN IF NOT EXISTS ind_show_role BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ind_show_topic BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ind_show_time BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ind_show_event_title BOOLEAN NOT NULL DEFAULT TRUE,
  -- Фото спикера: размер и положение (в % рабочей области).
  ADD COLUMN IF NOT EXISTS ind_photo_size INTEGER NOT NULL DEFAULT 45
      CHECK (ind_photo_size BETWEEN 10 AND 100),
  ADD COLUMN IF NOT EXISTS ind_photo_x INTEGER NOT NULL DEFAULT 50
      CHECK (ind_photo_x BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS ind_photo_y INTEGER NOT NULL DEFAULT 55
      CHECK (ind_photo_y BETWEEN 0 AND 100),
  -- Кегли текста индивидуальной афиши, px полотна (как в мигр. 457).
  ADD COLUMN IF NOT EXISTS ind_name_size NUMERIC(5,1) NOT NULL DEFAULT 54
      CHECK (ind_name_size BETWEEN 10 AND 200),
  ADD COLUMN IF NOT EXISTS ind_role_size NUMERIC(5,1) NOT NULL DEFAULT 24
      CHECK (ind_role_size BETWEEN 8 AND 100),
  ADD COLUMN IF NOT EXISTS ind_topic_size NUMERIC(5,1) NOT NULL DEFAULT 30
      CHECK (ind_topic_size BETWEEN 8 AND 120),
  ADD COLUMN IF NOT EXISTS ind_role_color TEXT,
  ADD COLUMN IF NOT EXISTS ind_topic_color TEXT;

COMMENT ON COLUMN event_poster_layouts.ind_photo_size IS
  'Размер фото спикера на индивидуальной афише, % ширины рабочей области';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
