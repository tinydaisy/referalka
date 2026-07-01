-- 185: кастомные названия вкладок Mini App на уровне клиента.
-- Пусто (NULL) — использовать дефолт из фронта. Одни на весь кабинет, действуют во всех событиях.
--   tab_label_program   — «Программа»
--   tab_label_speakers  — «Спикеры»   (только для тарифов с фичей 'conference')
--   tab_label_game      — «Подарки»   (внутренний id вкладки — game)
--   tab_label_ecosystem — «О проекте» (внутренний id вкладки — ecosystem)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS tab_label_program   TEXT,
  ADD COLUMN IF NOT EXISTS tab_label_speakers  TEXT,
  ADD COLUMN IF NOT EXISTS tab_label_game      TEXT,
  ADD COLUMN IF NOT EXISTS tab_label_ecosystem TEXT;
