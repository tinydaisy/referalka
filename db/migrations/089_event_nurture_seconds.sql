-- Миграция 089 (2026-05-20) — event_nurture_steps.offset_minutes → offset_seconds.
--
-- Зачем. В UI воронки догрева клиенту удобнее задавать интервалы числом
-- + единица (секунды/минуты/часы/сутки), а не только в минутах. Чтобы не
-- терять секунды (например, «через 30 секунд» для тестов) — храним в секундах.

ALTER TABLE event_nurture_steps ADD COLUMN IF NOT EXISTS offset_seconds INTEGER;
UPDATE event_nurture_steps SET offset_seconds = COALESCE(offset_minutes, 0) * 60
 WHERE offset_seconds IS NULL;
ALTER TABLE event_nurture_steps ALTER COLUMN offset_seconds SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_nurture_steps_offset_pos'
  ) THEN
    ALTER TABLE event_nurture_steps
      ADD CONSTRAINT event_nurture_steps_offset_pos CHECK (offset_seconds >= 0);
  END IF;
END $$;
ALTER TABLE event_nurture_steps DROP COLUMN IF EXISTS offset_minutes;
