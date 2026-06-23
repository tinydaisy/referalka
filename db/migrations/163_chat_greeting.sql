-- 163: Приветствие в чатах — кодовое слово + набор случайных фраз.
--
-- В разделе «Приветствие» события появляется подвкладка «В чатах» (рядом с
-- «На почту»). Логика: человек пишет в чате события (TG/VK/MAX) кодовое слово
-- (например «Я С ВАМИ») → бот ОТВЕТОМ (reply) на это сообщение присылает
-- СЛУЧАЙНУЮ фразу из набора. Отвечает всем, на каждое сообщение с кодовым словом.
--
-- ⚠️ Использует ту же слушалку чатов событий, что и «Контроль заданий»
--    (chat_listener.py / chat_archive.py + events.tg_chat_id/vk_chat_id/max_chat_id).
--    Бот ОБЯЗАН быть админом чата + privacy mode OFF в @BotFather.

-- 1) Включатель + кодовое слово на событие.
ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_greeting_enabled BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN events.chat_greeting_enabled IS 'Слушать чаты события и отвечать приветствием на кодовое слово (вкладка «Приветствие» → «В чатах»).';

ALTER TABLE events ADD COLUMN IF NOT EXISTS chat_greeting_keyword TEXT;
COMMENT ON COLUMN events.chat_greeting_keyword IS 'Кодовое слово/фраза для приветствия в чате (поиск в тексте сообщения, где угодно, без регистра).';

-- 2) Набор случайных фраз приветствия. Бот берёт одну рандомно.
CREATE TABLE IF NOT EXISTS event_chat_greetings (
    id          BIGSERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_chat_greetings_event_idx
    ON event_chat_greetings (event_id, sort, id);

GRANT SELECT, INSERT, UPDATE, DELETE ON event_chat_greetings TO plusson;
GRANT USAGE, SELECT ON event_chat_greetings_id_seq TO plusson;
