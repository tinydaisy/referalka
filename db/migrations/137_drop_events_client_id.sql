-- 137_drop_events_client_id.sql
-- ФИЗИЧЕСКОЕ удаление events.client_id. Владелец события — ТОЛЬКО в event_owners.
-- Все чтения переведены на event_owners (коммиты до этого). INSERT события пишут owner явно.

-- 1. Убираем триггеры 136, которые читали/зеркалили колонку
DROP TRIGGER IF EXISTS event_insert_owner ON events;
DROP TRIGGER IF EXISTS sync_event_client_id ON event_owners;
DROP FUNCTION IF EXISTS trg_event_insert_owner();
DROP FUNCTION IF EXISTS trg_sync_event_client_id();

-- 2. Гарантия: у каждого события есть owner в event_owners (перед дропом колонки)
INSERT INTO event_owners (event_id, client_id, status, role)
SELECT id, client_id, 'accepted', 'owner' FROM events WHERE client_id IS NOT NULL
ON CONFLICT (event_id, client_id) DO NOTHING;

-- 3. Дроп колонки
ALTER TABLE events DROP COLUMN IF EXISTS client_id;
