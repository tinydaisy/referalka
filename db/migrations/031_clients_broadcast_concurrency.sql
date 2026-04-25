-- 031: настраиваемая скорость рассылки на уровне клиента
-- broadcast_concurrency — сколько параллельных запросов в Telegram (по умолчанию 30).
-- Слишком высокий уровень ловит массовые HTTP 429 (Too Many Requests).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS broadcast_concurrency INTEGER NOT NULL DEFAULT 30;

-- Разумные границы — без мегасемафоров и нулей
ALTER TABLE clients
  ADD CONSTRAINT clients_broadcast_concurrency_chk
  CHECK (broadcast_concurrency BETWEEN 1 AND 100);
