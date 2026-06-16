-- Миграция 148: слушалка чатов события (TG / VK / MAX беседы)
-- Складываем КАЖДОЕ входящее сообщение чата события для подсчёта баллов
-- по ключевым словам. Отдельно от слушалки ботов (личка) — этот архив
-- ничего не отвечает, только копит сообщения с момента включения.

CREATE TABLE IF NOT EXISTS event_chat_messages (
    id              BIGSERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,                      -- telegram | vk | max
    chat_id         TEXT NOT NULL,                      -- id чата/беседы (как приходит с платформы)
    platform_user_id TEXT NOT NULL,                     -- id автора на этой платформе (tg_id / vk_id / max user_id)
    username        TEXT,                               -- @ник автора (если есть)
    author_name     TEXT,                               -- отображаемое имя автора (из апдейта)
    contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,  -- резолв в контакт клиента (если нашёлся)
    text            TEXT,                               -- текст сообщения (может быть пустым у медиа)
    has_attachment  BOOLEAN NOT NULL DEFAULT FALSE,     -- есть ли вложение
    attachment_kind TEXT,                               -- video | photo | document | audio | voice | ... (если есть)
    message_ref     TEXT,                               -- id сообщения на платформе (для дедупа)
    sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(), -- время сообщения (МСК-naive не используем — UTC)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_chat_messages_platform_chk CHECK (platform IN ('telegram','vk','max'))
);

-- Дедуп: одно и то же сообщение платформы не пишем дважды.
CREATE UNIQUE INDEX IF NOT EXISTS event_chat_messages_dedup_uq
    ON event_chat_messages (event_id, platform, chat_id, message_ref)
    WHERE message_ref IS NOT NULL;

-- Поиск по событию + времени (для отсечки «обнови с момента X»).
CREATE INDEX IF NOT EXISTS event_chat_messages_event_sent_idx
    ON event_chat_messages (event_id, sent_at);

-- Поиск автора по площадке (резолв в участника турнира).
CREATE INDEX IF NOT EXISTS event_chat_messages_author_idx
    ON event_chat_messages (event_id, platform, platform_user_id);

-- Полнотекстовый-лайт поиск по тексту (ускоряет ILIKE %ключевое слово%).
CREATE INDEX IF NOT EXISTS event_chat_messages_text_trgm_idx
    ON event_chat_messages USING gin (text gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON event_chat_messages TO plusson;
GRANT USAGE, SELECT ON event_chat_messages_id_seq TO plusson;
