-- 234: убираем лишнее webinar_registrations.referrer_ref_code.
-- Зритель вебинара = участник события (event_participants) на конкретном дне.
-- Реф-код рефовода уже есть в event_participants.referrer_ref_code — дублировать
-- его в вебинарной таблице не нужно. webinar_registrations остаётся чистой связкой
-- «зритель (contact_id) × комната дня (room_id)». Реф-код везде берётся JOIN-ом на
-- event_participants по (event_id комнаты, contact_id зрителя).

DROP INDEX IF EXISTS idx_webinar_reg_referrer;
ALTER TABLE webinar_registrations DROP COLUMN IF EXISTS referrer_ref_code;

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_registrations TO plusson;
