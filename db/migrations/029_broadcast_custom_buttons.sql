-- 029: поддержка произвольных рассылок (до 3 кнопок) и пакетного добавления
-- snapshot_buttons — массив кнопок вида [{text, url}, ...], применяется для type='custom'
-- Для шаблонных рассылок это поле остаётся NULL и используется одиночный snapshot_btn_text/url.

ALTER TABLE broadcast_schedules
  ADD COLUMN IF NOT EXISTS snapshot_buttons JSONB;
