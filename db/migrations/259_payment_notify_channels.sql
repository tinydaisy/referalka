-- 259: Канал уведомлений об ОПЛАТАХ (миграции 240-258).
--
-- Отдельно от общего канала уведомлений (notifications_*): туда льются
-- сообщения «новый интерес», вопросы людей и прочий поток. Оплаты в нём
-- теряются, а их нужно видеть сразу и, как правило, показывать другим
-- людям — бухгалтеру, куратору, партнёру.
--
-- Пусто → уведомления об оплатах идут в общий канал (если он задан).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS payments_telegram_chat_id TEXT,
  ADD COLUMN IF NOT EXISTS payments_max_chat_id      TEXT,
  ADD COLUMN IF NOT EXISTS payments_vk_peer_id       TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO plusson;
