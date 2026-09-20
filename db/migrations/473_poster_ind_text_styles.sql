-- 473: у темы и времени на афише спикера СВОИ шрифт, размер и цвет.
--
-- ⚠️⚠️ ЗАЧЕМ. Настроек у этих элементов почти не было:
--   • у ВРЕМЕНИ не было ни одной — размер считался как `ind_topic_size * 0.8`,
--     цвет жёстко брался брендовый. Сделать время крупнее темы или другим
--     цветом было нельзя в принципе;
--   • у ТЕМЫ размер был, а цвет лежал в базе, но в интерфейс выведен не был;
--   • шрифта не было ни у того, ни у другого — оба наследовали шрифт афиши.
-- Владелец не раз просил эти настройки и не видел их (20.09.2026).
--
-- ⚠️ Размеры в ПИКСЕЛЯХ полотна — как все кегли афиши с миграции 457.
-- Проценты давали разброс между форматами, и подобрать размер было нельзя.
--
-- ⚠️ NULL у цвета и шрифта = «как было»: цвет темы — белый, цвет времени —
-- брендовый, шрифт — шрифт афиши. Так уже собранные афиши не поедут.

BEGIN;

ALTER TABLE event_poster_layouts
  -- Тема выступления.
  ADD COLUMN IF NOT EXISTS ind_topic_font TEXT,
  -- Время выступления: раньше не имело ничего своего.
  ADD COLUMN IF NOT EXISTS ind_time_font TEXT,
  ADD COLUMN IF NOT EXISTS ind_time_size NUMERIC(5,1) NOT NULL DEFAULT 24
      CHECK (ind_time_size BETWEEN 8 AND 120),
  ADD COLUMN IF NOT EXISTS ind_time_color TEXT,
  -- Имя и роль тоже получают свой шрифт: сейчас оба жёстко на шрифте
  -- заголовка, и развести их было нельзя.
  ADD COLUMN IF NOT EXISTS ind_name_font TEXT,
  ADD COLUMN IF NOT EXISTS ind_role_font TEXT;

COMMENT ON COLUMN event_poster_layouts.ind_time_size IS
  'Кегль времени выступления, px полотна. Раньше считался как 80 % от кегля '
  'темы и своей настройки не имел';
COMMENT ON COLUMN event_poster_layouts.ind_time_color IS
  'Цвет времени. NULL — брендовый акцент (прежнее поведение)';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
