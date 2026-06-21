-- Миграция 160: личные переписки (Диалоги) — история ЛС человека с ботом/сообществом.
--
-- ⚠️ ОТДЕЛЬНО от event_chat_messages (миграция 152): та — про ГРУППОВЫЕ чаты
--    событий и подсчёт баллов. Эта — про ЛИЧНЫЕ переписки 1-на-1, чтобы клиент
--    видел всю историю (что человек пишет / что отвечает бот / что отвечает
--    оператор-клиент) и сам отвечал через свои боты TG/VK/MAX.
--
-- АРХИТЕКТУРА ХРАНЕНИЯ (важно — сервер маленький по памяти):
--   • ТЕКСТ сообщения хранится здесь, в Postgres (лёгкий, быстрый поиск/выдача).
--   • МЕДИА (фото/видео/голос/документ) — в R2 по ключу
--     clients/{client_id}/dialogs/{contact_id}/{message_id}/{uuid}.{ext},
--     в БД только media_url + media_kind. Папка контакта целиком переносима.
--   • ГОЛОСОВЫЕ файлы НЕ качаем — только пометка media_kind='voice' (бот
--     отвечает «пишите текстом»).
--   • RETENTION: «горячие» сообщения в Postgres, старые архивируются скриптом
--     в R2 (jsonl) и удаляются из таблицы — чтобы не раздувать RAM сервера.

CREATE TABLE IF NOT EXISTS direct_messages (
    id                  BIGSERIAL PRIMARY KEY,
    client_id           INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id          INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    platform            TEXT NOT NULL,                       -- telegram | vk | max
    channel_id          INTEGER REFERENCES channels(id) ON DELETE SET NULL,  -- через какой бот/сообщество
    platform_user_id    TEXT NOT NULL,                       -- собеседник: tg_id / vk_id / max user_id
    direction           TEXT NOT NULL,                       -- in (человек→бот) | out (бот/оператор→человек)
    author_kind         TEXT NOT NULL,                       -- contact | bot | operator
    text                TEXT,                                -- текст (может быть пустым у медиа)
    media_url           TEXT,                                -- ссылка на файл в R2 (если медиа)
    media_kind          TEXT,                                -- photo | video | document | audio | voice | sticker | other
    platform_message_id TEXT,                                -- id сообщения на платформе (для edit/delete + дедуп)
    is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,      -- сообщение удалено (оператором)
    is_read             BOOLEAN NOT NULL DEFAULT FALSE,      -- входящее прочитано клиентом в дашборде
    error               TEXT,                                -- ошибка отправки (напр. VK 901 «запретил ЛС»)
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT now(),  -- время сообщения (UTC)
    edited_at           TIMESTAMPTZ,                         -- когда оператор отредактировал
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT direct_messages_platform_chk  CHECK (platform IN ('telegram','vk','max')),
    CONSTRAINT direct_messages_direction_chk CHECK (direction IN ('in','out')),
    CONSTRAINT direct_messages_author_chk    CHECK (author_kind IN ('contact','bot','operator'))
);

-- Дедуп входящих: одно и то же сообщение платформы не пишем дважды.
CREATE UNIQUE INDEX IF NOT EXISTS direct_messages_dedup_uq
    ON direct_messages (client_id, platform, platform_user_id, direction, platform_message_id)
    WHERE platform_message_id IS NOT NULL;

-- Лента диалога: быстрый разворот переписки по контакту.
CREATE INDEX IF NOT EXISTS direct_messages_contact_idx
    ON direct_messages (client_id, contact_id, sent_at);

-- Список диалогов клиента: последнее сообщение по каждому собеседнику.
CREATE INDEX IF NOT EXISTS direct_messages_client_sent_idx
    ON direct_messages (client_id, sent_at DESC);

-- Резолв собеседника по площадке (если contact_id ещё не привязан).
CREATE INDEX IF NOT EXISTS direct_messages_author_idx
    ON direct_messages (client_id, platform, platform_user_id);

-- Полнотекстовый-лайт поиск по тексту.
CREATE INDEX IF NOT EXISTS direct_messages_text_trgm_idx
    ON direct_messages USING gin (text gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON direct_messages TO plusson;
GRANT USAGE, SELECT ON direct_messages_id_seq TO plusson;
