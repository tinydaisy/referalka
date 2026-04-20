-- ═══════════════════════════════════════════
-- Миграция 013: Учёт рефоводов через ref_code
-- Дата: 2026-04-20
-- ═══════════════════════════════════════════
-- Добавляет колонку referrer_ref_code в event_participants,
-- чтобы можно было записать рефовода-спикера (ref_code которого
-- живёт в conf_speaker_events, а не в event_participants).
-- Удаляет устаревшую колонку promo_partner_code.
-- ═══════════════════════════════════════════

ALTER TABLE event_participants
  ADD COLUMN IF NOT EXISTS referrer_ref_code TEXT;

CREATE INDEX IF NOT EXISTS idx_event_participants_referrer_refcode
  ON event_participants(referrer_ref_code);

ALTER TABLE event_participants
  DROP COLUMN IF EXISTS promo_partner_code;
