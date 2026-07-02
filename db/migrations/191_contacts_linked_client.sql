-- 191: Привязка КОНТАКТА к ПЛЮСОН-клиенту (не только спикеры).
--
-- Раньше связка «человек ↔ его ПЛЮСОН-аккаунт» жила только на collaborators
-- (linked_client_id) — то есть рекламить ПЛЮСОН и закреплять приведённых мог
-- только спикер. Теперь любой участник-контакт, у кого есть аккаунт ПЛЮСОНа,
-- может связать себя и закреплять за собой приведённых.
--
-- Резолвер ref-кодов (resolve_plusson_referrer) сначала смотрит contacts.
-- linked_client_id, затем — collaborators.linked_client_id (fallback).

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS linked_client_id INTEGER NULL
    REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_linked_client
  ON contacts(linked_client_id) WHERE linked_client_id IS NOT NULL;
