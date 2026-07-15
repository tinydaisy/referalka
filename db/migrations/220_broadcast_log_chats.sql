-- 220. Статистика отправок В ЧАТЫ в broadcast_log.
--
-- ЗАЧЕМ. Рассылка может уходить не только в личку (по ботам, platform_user_id),
-- но и в ГРУППОВЫЕ чаты: чат события (VK/MAX), общие и личные чаты клиента
-- (client_broadcast_chats). Эти отправки НИГДЕ не логировались — в модалке
-- «Получатели рассылки» их не было видно.
--
-- Теперь чат-доставки тоже пишутся в broadcast_log отдельными строками. Чат —
-- не пользователь, поэтому platform_user_id делаем nullable и добавляем поля,
-- описывающие чат.

-- platform_user_id теперь может быть NULL (строка про чат, а не про пользователя)
ALTER TABLE broadcast_log ALTER COLUMN platform_user_id DROP NOT NULL;

ALTER TABLE broadcast_log
  -- Вид чата: 'event' (чат события) | 'client_common' (общий чат клиента) |
  -- 'client_private' (личный канал клиента). NULL = обычная личная отправка.
  ADD COLUMN IF NOT EXISTS chat_kind  TEXT,
  -- Платформа чата (telegram/vk/max/whatsapp) — для группировки в статистике.
  ADD COLUMN IF NOT EXISTS chat_platform TEXT,
  -- Куда ушло: chat_id / peer_id (для показа в списке).
  ADD COLUMN IF NOT EXISTS chat_ref   TEXT,
  -- Читаемое название чата, если известно.
  ADD COLUMN IF NOT EXISTS chat_title TEXT;

-- Строка лога описывает ЛИБО пользователя, ЛИБО чат.
ALTER TABLE broadcast_log
  ADD CONSTRAINT broadcast_log_user_or_chat CHECK (
    platform_user_id IS NOT NULL OR chat_kind IS NOT NULL
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_log TO plusson;
