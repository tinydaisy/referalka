-- 141_clients_self_collaborator.sql
-- Явное закрытое поле-связь «клиент → его собственная карточка-коллаб».
-- Назначение: запрет удаления своей карточки + авто-добавление себя организатором
-- в коллаб-событие + явная замена неявной связи по имени/created_by_client_id.
-- На фронте поле НЕ показывается — служебное.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS self_collaborator_id INTEGER
    REFERENCES collaborators(id) ON DELETE SET NULL;

-- Бэкфилл существующим клиентам: если у клиента уже есть коллаб, чей contact
-- принадлежит этому же клиенту (его собственная карточка), и self_collaborator_id
-- ещё не задан — привязываем самый ранний такой коллаб.
UPDATE clients cl
   SET self_collaborator_id = sub.collab_id
  FROM (
    SELECT ct.client_id, MIN(co.id) AS collab_id
      FROM collaborators co
      JOIN contacts ct ON ct.id = co.contact_id
     GROUP BY ct.client_id
  ) sub
 WHERE cl.id = sub.client_id
   AND cl.self_collaborator_id IS NULL;
