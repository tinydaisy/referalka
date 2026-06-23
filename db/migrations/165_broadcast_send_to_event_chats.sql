-- 165: галочка «отправлять в чаты события» у шаблона/расписания рассылки.
-- Если TRUE — рассылка идёт В ДОПОЛНЕНИЕ к базе подписчиков ещё и в групповые
-- чаты события: events.tg_chat_id / vk_chat_id / max_chat_id (по платформам).

ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS send_to_event_chats BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE broadcast_schedules
  ADD COLUMN IF NOT EXISTS send_to_event_chats BOOLEAN NOT NULL DEFAULT FALSE;
