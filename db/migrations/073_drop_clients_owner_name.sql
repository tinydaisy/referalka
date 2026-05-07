-- 073_drop_clients_owner_name.sql (07.05.2026)
-- Удаляем clients.owner_name — поле больше не редактируется и не используется.
-- В Mini App имя основателя теперь = clients.name (имя из регистрации).
-- В шаблонах воронок плейсхолдер {client_owner_name} тоже подставляется из clients.name
-- (см. backend/app/services/funnel_service.py — SELECT name AS owner_name).

BEGIN;

ALTER TABLE clients DROP COLUMN IF EXISTS owner_name;

COMMIT;
