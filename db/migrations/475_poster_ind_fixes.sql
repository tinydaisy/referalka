-- 475: афиша спикера — своё название конференции, роль спикера, метал у текста.
--
-- ⚠️ 1. СВОЁ ПОЛЕ НАЗВАНИЯ. Название конференции на афише спикера бралось из
-- `title` — того же поля, что заголовок общей афиши. Поэтому оно «цеплялось
-- не то» и не редактировалось там, где клиент его искал: правка заголовка
-- общей афиши меняла подпись на спикерской и наоборот.
--
-- ⚠️ 2. МЕТАЛЛИЧЕСКИЙ ОТЛИВ. У заголовка общей афиши он есть (`title_metallic`),
-- у названия на спикерской не было вовсе.

BEGIN;

ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_title_text TEXT,
  ADD COLUMN IF NOT EXISTS ind_title_metallic BOOLEAN NOT NULL DEFAULT FALSE,
  -- Дату рядом со временем показывать или только время.
  ADD COLUMN IF NOT EXISTS ind_time_with_date BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN event_poster_layouts.ind_title_text IS
  'Название конференции на афише спикера. Пусто — берётся название события. '
  'Отдельно от `title`: то поле — заголовок ОБЩЕЙ афиши';
COMMENT ON COLUMN event_poster_layouts.ind_time_with_date IS
  'Показывать дату вместе со временем («24.09 в 11:00») или только время';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
