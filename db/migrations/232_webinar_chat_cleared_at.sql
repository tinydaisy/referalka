-- 232: «живой» чат комнаты чистится при «Начать заново»/«Закрыть комнату».
-- chat_cleared_at — момент, с которого показывается ЖИВОЙ чат (в состояниях b/c до
-- старта первого эфира сессии ещё нет, сообщения пишутся с session_id=NULL). После
-- reset/close ставим NOW() → старые сообщения исчезают из живого показа, но остаются
-- в БД (история сессии видна в «Записях» по session_id). Новый цикл — чистый чат.

ALTER TABLE webinar_rooms
  ADD COLUMN IF NOT EXISTS chat_cleared_at TIMESTAMPTZ;

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_rooms TO plusson;
