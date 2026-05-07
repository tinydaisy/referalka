-- 074_drop_clients_tariff_columns.sql (07.05.2026)
-- Удаляем тарифные поля из clients — теперь источник истины client_subscriptions.
-- clients.tariff_slug дублирует client_subscriptions.tariff_id (через current_subscription_id).
-- clients.trial_ends_at дублирует client_subscriptions.expires_at для триал-подписки.
--
-- В коде уже всё переключено на client_subscriptions:
--   - /auth/me — отдаёт subscription{} с tariff_slug/expires_at внутри
--   - /admin/clients — JOIN на client_subscriptions
--   - PATCH /admin/clients/{id} с tariff_slug — создаёт новую подписку (не правит clients)

BEGIN;

-- Перед DROP колонки нужно убрать FK constraint на tariffs.slug
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_tariff_slug_fkey;
ALTER TABLE clients DROP COLUMN IF EXISTS tariff_slug;
ALTER TABLE clients DROP COLUMN IF EXISTS trial_ends_at;

COMMIT;
