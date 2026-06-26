-- Миграция 170: база внешних чатов/групп/каналов клиента для рассылок.
-- Выносит «доп. чаты для отправки» с уровня события на уровень КЛИЕНТА —
-- единая база, в которую дополнительно льются рассылки (общие и событийные).
-- Гейт по фиче broadcast_chats (только тариф Экстра 2990 + admin).

CREATE TABLE IF NOT EXISTS client_broadcast_chats (
    id          BIGSERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,            -- telegram | vk | max
    chat_id     TEXT NOT NULL,            -- числовой id чата/беседы/канала
    title       TEXT,                     -- название (подтянутое или вписанное вручную)
    chat_url    TEXT,                     -- ссылка на группу/канал (если публичная)
    is_public   BOOLEAN NOT NULL DEFAULT FALSE,
    added_via   TEXT NOT NULL DEFAULT 'manual',  -- link (определён по ссылке) | manual (вписан вручную)
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT client_broadcast_chats_platform_chk CHECK (platform IN ('telegram','vk','max')),
    CONSTRAINT client_broadcast_chats_uq UNIQUE (client_id, platform, chat_id)
);

CREATE INDEX IF NOT EXISTS client_broadcast_chats_client_idx
    ON client_broadcast_chats (client_id, platform) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON client_broadcast_chats TO plusson;
GRANT USAGE, SELECT ON client_broadcast_chats_id_seq TO plusson;

-- Флаг рассылки «слать в общие чаты клиента» (отдельно от send_to_event_chats).
-- Наследуется так же, как target_channel_ids / send_to_event_chats.
ALTER TABLE broadcast_templates ADD COLUMN IF NOT EXISTS send_to_client_chats BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS send_to_client_chats BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN broadcast_templates.send_to_client_chats IS 'Слать также в общую базу чатов клиента (client_broadcast_chats).';
COMMENT ON COLUMN broadcast_schedules.send_to_client_chats IS 'Слать также в общую базу чатов клиента (client_broadcast_chats).';
