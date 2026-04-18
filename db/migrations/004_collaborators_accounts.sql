-- Добавить поля аккаунтов и каналов в таблицу collaborators
ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS channel_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS personal_account_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS personal_account_username VARCHAR(128),
  ADD COLUMN IF NOT EXISTS assistant_account VARCHAR(128);
