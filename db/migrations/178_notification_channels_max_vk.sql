-- 178: каналы уведомлений на MAX и VK (помимо Telegram)
--
-- Зачем. Уведомления организатору (#user_message, «Новый интерес») раньше шли
-- только в Telegram-канал (clients.notifications_telegram_chat_id). Теперь клиент
-- может задать ещё MAX-канал и VK-беседу/сообщество — уведомление ДУБЛИРУЕТСЯ во
-- все заполненные каналы (TG + MAX + VK), независимо от площадки человека.
--
-- Отправка:
--   TG  — sendMessage ботом клиента в notifications_telegram_chat_id (как было)
--   MAX — POST /messages?chat_id=<notifications_max_chat_id> MAX-ботом клиента
--   VK  — messages.send(peer_id=notifications_vk_peer_id) сообществом клиента
--
-- chat_id MAX-канала / peer_id VK-беседы клиент получает командой /getmyid
-- (бот должен быть в канале/беседе) или кнопкой «Получить автоматически».

ALTER TABLE clients ADD COLUMN IF NOT EXISTS notifications_max_chat_id  TEXT NULL;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notifications_vk_peer_id   TEXT NULL;

COMMENT ON COLUMN clients.notifications_max_chat_id IS 'chat_id MAX-канала/беседы для уведомлений организатору (MAX-бот клиента должен быть в нём). Дублируется с TG/VK.';
COMMENT ON COLUMN clients.notifications_vk_peer_id  IS 'peer_id VK-беседы/сообщества для уведомлений организатору (сообщество клиента шлёт). Дублируется с TG/MAX.';
