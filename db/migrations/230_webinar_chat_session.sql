-- 230: чат вебинарной комнаты привязывается к ЭФИРНОЙ СЕССИИ (запуску).
-- Зачем: после перезапуска эфира чат должен быть НОВЫЙ (сообщения прошлого запуска
-- не показываются вживую), но история каждого запуска сохраняется вместе с записью
-- этой сессии. Раньше чат жил «по дню» (room_id) — старые сообщения всплывали заново.
-- session_id NULL = старые сообщения (совместимость), в живой чат нового запуска не идут.

ALTER TABLE webinar_chat_messages
  ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES webinar_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_webinar_chat_session ON webinar_chat_messages(session_id, at);

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_chat_messages TO plusson;
