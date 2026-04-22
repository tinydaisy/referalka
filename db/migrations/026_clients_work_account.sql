-- Миграция 026: рабочий Telegram-аккаунт клиента
-- Используется для проверки подписки на каналы спикеров

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS work_tg_username TEXT,
    ADD COLUMN IF NOT EXISTS work_tg_id        BIGINT;
