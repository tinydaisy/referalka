-- Миграция 150: чаты, где бот состоит админом (для кнопки «Определить ID»).
-- Заполняется при добавлении бота в чат (my_chat_member) и командой /chatid.
-- Кнопка в дашборде читает эту таблицу и подставляет нужный chat_id в событие.

CREATE TABLE IF NOT EXISTS bot_known_chats (
    id            BIGSERIAL PRIMARY KEY,
    client_id     INTEGER REFERENCES clients(id) ON DELETE CASCADE,  -- владелец бота (NULL = системный @pluson_bot)
    platform      TEXT NOT NULL,            -- telegram | vk | max
    chat_id       TEXT NOT NULL,            -- числовой id чата/беседы
    title         TEXT,                     -- название чата (для выбора в UI)
    bot_id        TEXT,                     -- id бота, который видит этот чат
    can_read      BOOLEAN NOT NULL DEFAULT TRUE,  -- может ли бот читать сообщения (privacy off / админ)
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bot_known_chats_platform_chk CHECK (platform IN ('telegram','vk','max')),
    CONSTRAINT bot_known_chats_uq UNIQUE (platform, chat_id, bot_id)
);

CREATE INDEX IF NOT EXISTS bot_known_chats_client_idx ON bot_known_chats (client_id, platform);

GRANT SELECT, INSERT, UPDATE, DELETE ON bot_known_chats TO plusson;
GRANT USAGE, SELECT ON bot_known_chats_id_seq TO plusson;

-- Поле для TG: какой именно чат события слушаем (отдельно от CSV telegram_chat_ids,
-- который для рассылок и может содержать левые чаты).
ALTER TABLE events ADD COLUMN IF NOT EXISTS tg_chat_id TEXT;
COMMENT ON COLUMN events.tg_chat_id  IS 'Числовой chat_id TG-беседы события для слушалки заданий (НЕ путать с telegram_chat_ids — тот для рассылок).';
