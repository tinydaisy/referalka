-- 030: общие рассылки клиента (не привязанные к событию)
-- event_id становится nullable; добавляется client_id для записей без события.
-- Аудитория: только all_client (вся база контактов клиента).

ALTER TABLE broadcast_schedules
  ALTER COLUMN event_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE;

-- Заполняем client_id для существующих записей из events.client_id
UPDATE broadcast_schedules bs
   SET client_id = e.client_id
  FROM events e
 WHERE bs.event_id = e.id
   AND bs.client_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_broadcast_schedules_client ON broadcast_schedules (client_id, status, fire_at);
