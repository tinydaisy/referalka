-- Добавляем поле test_telegram_ids в conf_conferences
-- Хранит список Telegram ID для тестовых рассылок (TEXT[], например: '{8018913774,7879070738,5725111966}')
ALTER TABLE conf_conferences
  ADD COLUMN IF NOT EXISTS test_telegram_ids TEXT[] DEFAULT '{}';
