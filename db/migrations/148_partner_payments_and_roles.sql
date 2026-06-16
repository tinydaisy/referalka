-- 148_partner_payments_and_roles.sql
-- Партнёрский блок основателя: ссылка на отслеживание оплат + кому показывать.
-- 1) partner_payments_url — страница отслеживания выплат/оплат во внешней
--    партнёрской системе (отдельно от кабинета партнёра).
-- 2) partner_visible_roles — кому показывать партнёрский блок в кабинете спикера:
--    подмножество ['jury','speaker','participant','organizer','partner'].
--    speaker = обычные speaker + headliner; partner = partner + general_partner
--    (раскрытие на стороне кода). Пусто/NULL = никому (по умолчанию).

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS partner_payments_url  TEXT,
    ADD COLUMN IF NOT EXISTS partner_visible_roles TEXT[] DEFAULT '{}'::text[];

COMMENT ON COLUMN clients.partner_payments_url  IS 'Ссылка на отслеживание оплат во внешней партнёрской системе';
COMMENT ON COLUMN clients.partner_visible_roles IS 'Кому показывать партнёрский блок в кабинете: jury/speaker/participant/organizer/partner';
