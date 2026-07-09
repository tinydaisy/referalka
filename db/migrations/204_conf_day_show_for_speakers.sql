-- Миграция 204: галочка «Показывать день в кабинете спикера»
-- По умолчанию TRUE — день виден спикерам; организатор точечно выключает лишние
-- (орг-встречи, экспертные дни и т.п.), чтобы спикер в кабинете видел только те дни,
-- где ему есть что делать.

ALTER TABLE conf_days
  ADD COLUMN IF NOT EXISTS show_for_speakers BOOLEAN NOT NULL DEFAULT TRUE;

-- GRANT на роль plusson (роль БД не владелец таблиц)
GRANT SELECT, INSERT, UPDATE, DELETE ON conf_days TO plusson;
