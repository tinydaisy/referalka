-- 102_clients_test_email_ids.sql
-- Список email-адресов для тестовых рассылок клиента.
-- По аналогии с clients.test_telegram_ids / test_vk_ids / test_max_ids — если
-- клиент включает в форме рассылки чекбокс «Тестовая», получатели сужаются
-- ТОЛЬКО до этих адресов (в email-части _send_broadcast_email_part).

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS test_email_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN clients.test_email_ids IS
    'Список email-адресов для тестовых рассылок клиента (sub-set от его базы)';

COMMIT;
