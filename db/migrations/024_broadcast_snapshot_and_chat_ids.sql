-- 024: снапшот текста шаблона в очереди + telegram_chat_ids в конференции

-- 1. Снапшот текста/фото/кнопки на момент добавления в очередь.
--    Если поля заполнены — используются они, а не текущий текст шаблона.
ALTER TABLE broadcast_schedules
  ADD COLUMN IF NOT EXISTS snapshot_text     TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_photo    TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_btn_text TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_btn_url  TEXT;

-- 2. Список Telegram chat_id для дополнительной отправки копии каждой рассылки.
--    Хранится как строка с ID через запятую (например: "-1001234567890,-100987654321")
--    Может уже существовать — используем IF NOT EXISTS.
ALTER TABLE conf_conferences
  ADD COLUMN IF NOT EXISTS telegram_chat_ids TEXT;
