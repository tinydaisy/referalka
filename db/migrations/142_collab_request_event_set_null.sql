-- 142_collab_request_event_set_null.sql
-- БАГ: при reconsider (передумать после принятия) код удаляет пустое авто-событие
-- (DELETE FROM events), а FK hub_collab_requests.event_id был ON DELETE CASCADE →
-- сам запрос удалялся каскадом, вместо того чтобы вернуться в pending и остаться
-- висеть как новый/неотвеченный. Меняем на ON DELETE SET NULL — запрос живёт,
-- обнуляется только привязка к событию.

ALTER TABLE hub_collab_requests
  DROP CONSTRAINT IF EXISTS hub_collab_requests_event_id_fkey;

ALTER TABLE hub_collab_requests
  ADD CONSTRAINT hub_collab_requests_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL;
