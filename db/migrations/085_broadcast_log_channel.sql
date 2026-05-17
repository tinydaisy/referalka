-- 085 — broadcast_log.channel_id
--
-- Зачем. Рассылка теперь шлёт сообщение через КАЖДЫЙ подписанный (не-отписанный)
-- канал клиента (fanout, см. изменения 17.05.2026). Один контакт может получить
-- по N сообщений (по числу его подписок). Чтобы различать строки лога и считать
-- «сколько ушло через какого бота» — фиксируем канал отправки в самом логе.
--
-- Старые строки до миграции остаются без channel_id (NULL) и в UI группируются
-- как «без указания канала».

ALTER TABLE broadcast_log
  ADD COLUMN IF NOT EXISTS channel_id INT REFERENCES channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_broadcast_log_channel ON broadcast_log(channel_id);
