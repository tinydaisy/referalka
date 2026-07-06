-- 196: Разделение чатов рассылок на «общие» и «личные» + флаг «личные каналы» в рассылках.
--
-- client_broadcast_chats.is_private:
--   FALSE (default) — общий чат (реклама, публичное).
--   TRUE            — личный канал клиента (не всех туда пускаем).
--
-- Три НЕЗАВИСИМЫЕ галочки рассылки (в шаблонах и расписаниях):
--   send_to_event_chats    — слать в чат СОБЫТИЯ (уже был).
--   send_to_client_chats   — слать в ОБЩИЕ чаты (is_private=FALSE). Уже был — семантика
--                            уточнена: теперь только общие, не личные.
--   send_to_private_chats  — слать в ЛИЧНЫЕ каналы (is_private=TRUE). Новый.
-- Дедуп по chat_id: пересекающиеся чаты не получают сообщение дважды.

ALTER TABLE client_broadcast_chats
    ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE broadcast_templates
    ADD COLUMN IF NOT EXISTS send_to_private_chats BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS send_to_private_chats BOOLEAN NOT NULL DEFAULT FALSE;
