-- 148_partner_payments_and_roles.sql
-- Партнёрский блок основателя: кому показывать в кабинете.
-- partner_visible_roles — кому показывать партнёрский блок в кабинете спикера:
--   подмножество ['jury','speaker','participant','organizer','partner'].
--   speaker = обычные speaker + headliner; partner = partner + general_partner
--   (раскрытие на стороне кода). Пусто/NULL = никому (по умолчанию).
--
-- ⚠️ partner_payments_url НЕ вводим — «отслеживание оплат» = существующий
-- partner_dashboard_url (URL кабинета партнёра, где видны выплаты). Не плодим
-- дубль. Если колонка была создана ранней версией миграции — удаляем.

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS partner_visible_roles TEXT[] DEFAULT '{}'::text[];

ALTER TABLE clients DROP COLUMN IF EXISTS partner_payments_url;

COMMENT ON COLUMN clients.partner_visible_roles IS 'Кому показывать партнёрский блок в кабинете: jury/speaker/participant/organizer/partner';
