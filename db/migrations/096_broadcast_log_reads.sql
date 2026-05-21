-- Миграция 096: отметка о прочтении сообщения в broadcast_log
--
-- Зачем. Юзер хочет видеть статистику охватов рассылок: «доставлено N,
-- прочитано M». Telegram Bot API физически не даёт read receipts в приватных
-- чатах с ботом (только delivery confirmation = sendMessage OK). А VK Long
-- Poll сообщества имеет событие `message_read` (юзер открыл и прочитал
-- сообщение от сообщества) — реальная метрика прочтения.
--
-- Что добавляем:
-- - external_message_id BIGINT — id сообщения в платформе-отправителе
--   (для VK это vk message_id из messages.send response). Для TG может быть
--   id сообщения в чате с ботом, на случай если в будущем кто-то даст read
--   receipts (пока не используется).
-- - read_at TIMESTAMPTZ — когда получено событие message_read от платформы.
--   NULL = не прочитано (или платформа не сообщает о прочтениях, как TG).
--
-- Поиск при поступлении event'а message_read: VK Long Poll даёт пару
-- (from_id, last_message_id) → апдейтим broadcast_log где channel_id =
-- VK-канал клиента, platform_users.platform_user_id = from_id и
-- external_message_id <= last_message_id и read_at IS NULL.
-- Под этот запрос — составной индекс.

ALTER TABLE broadcast_log
  ADD COLUMN IF NOT EXISTS external_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_broadcast_log_channel_pu_extid
  ON broadcast_log (channel_id, platform_user_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

COMMENT ON COLUMN broadcast_log.external_message_id IS 'ID сообщения в платформе-отправителе (vk message_id и т.п.) — для матчинга read events';
COMMENT ON COLUMN broadcast_log.read_at IS 'Когда получили event «прочитано» от платформы (для VK — message_read). NULL если не прочитано или платформа не сообщает.';
