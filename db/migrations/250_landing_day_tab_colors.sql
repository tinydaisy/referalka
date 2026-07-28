-- 250: Цвета переключателя дней программы на лендинге (миграции 240-249).
--
-- Зачем. Активный день красился заливкой акцентного цвета, а текст на нём
-- брался из цвета текста КНОПОК. У кнопки заливка своя (например, красная),
-- поэтому её текст на персиковой плашке дня мог оказаться нечитаемым.
--
--   day_tab_color      — заливка активного дня; пусто = цвет иконок темы
--   day_tab_text_color — текст на активном дне; пусто = цвет фона страницы
--                        (тёмный на светлой плашке — контраст по умолчанию)

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_day_tab_color      TEXT,
  ADD COLUMN IF NOT EXISTS lp_day_tab_text_color TEXT;

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS day_tab_color      TEXT,
  ADD COLUMN IF NOT EXISTS day_tab_text_color TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;
