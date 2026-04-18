-- Переименовать колонки аккаунтов в collaborators
ALTER TABLE collaborators RENAME COLUMN telegram_url TO tg_channel_url;
ALTER TABLE collaborators RENAME COLUMN channel_id TO tg_channel_id;
ALTER TABLE collaborators RENAME COLUMN personal_account_id TO personal_tg_id;
ALTER TABLE collaborators RENAME COLUMN personal_account_username TO personal_tg_username;
ALTER TABLE collaborators RENAME COLUMN assistant_account TO assistant_tg_username;

-- Изменить тип achievements на массив строк
ALTER TABLE collaborators ALTER COLUMN achievements TYPE text[] USING
  CASE
    WHEN achievements IS NULL THEN NULL
    ELSE ARRAY[achievements]
  END;
