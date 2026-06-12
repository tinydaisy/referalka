-- 136_event_owners_source_of_truth.sql
-- Делаем event_owners ЕДИНСТВЕННЫМ источником истины о владельцах события.
-- events.client_id перестаёт быть «настоящим владельцем» — становится авто-зеркалом
-- (поддерживается триггером от event_owners) ради ~62 legacy-мест, которые читают e.client_id.
-- Семантически владелец теперь ТОЛЬКО в event_owners. Никакого «основного владельца» — все организаторы равны.

-- 1. При создании события — авто-создать owner-запись в event_owners (чтобы новые события сразу имели владельца там)
CREATE OR REPLACE FUNCTION trg_event_insert_owner() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.client_id IS NOT NULL THEN
        INSERT INTO event_owners (event_id, client_id, status, role)
        VALUES (NEW.id, NEW.client_id, 'accepted', 'owner')
        ON CONFLICT (event_id, client_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_insert_owner ON events;
CREATE TRIGGER event_insert_owner AFTER INSERT ON events
    FOR EACH ROW EXECUTE FUNCTION trg_event_insert_owner();

-- 2. event_owners → events.client_id зеркалится (для legacy e.client_id).
--    client_id = владелец с role='owner' (инициатор), либо любой accepted если owner ушёл.
CREATE OR REPLACE FUNCTION trg_sync_event_client_id() RETURNS TRIGGER AS $$
DECLARE
    ev_id INTEGER;
    new_owner INTEGER;
BEGIN
    ev_id := COALESCE(NEW.event_id, OLD.event_id);
    SELECT client_id INTO new_owner
      FROM event_owners
     WHERE event_id = ev_id AND status = 'accepted'
     ORDER BY (role = 'owner') DESC, id
     LIMIT 1;
    UPDATE events SET client_id = new_owner WHERE id = ev_id AND client_id IS DISTINCT FROM new_owner;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sync_event_client_id ON event_owners;
CREATE TRIGGER sync_event_client_id AFTER INSERT OR UPDATE OR DELETE ON event_owners
    FOR EACH ROW EXECUTE FUNCTION trg_sync_event_client_id();

-- 3. Бэкфилл: у всех существующих событий гарантируем owner-запись (на случай если бэкфилл 134 что-то упустил)
INSERT INTO event_owners (event_id, client_id, status, role)
SELECT id, client_id, 'accepted', 'owner' FROM events WHERE client_id IS NOT NULL
ON CONFLICT (event_id, client_id) DO NOTHING;
