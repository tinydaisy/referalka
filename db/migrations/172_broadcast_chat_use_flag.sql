-- Миграция 172: флаг «использовать чат для рассылок анонсов» на client_broadcast_chats.
--
-- Отдельно от is_active (чат в базе). Галочка «использовать для рассылок» —
-- по умолчанию включена. Рассылки (общие и из событий) по базе чатов идут
-- ТОЛЬКО по тем чатам, где галочка стоит.

ALTER TABLE client_broadcast_chats
    ADD COLUMN IF NOT EXISTS use_for_broadcasts BOOLEAN NOT NULL DEFAULT TRUE;
