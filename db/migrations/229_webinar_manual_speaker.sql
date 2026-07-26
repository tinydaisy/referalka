-- 229. Вебинар: ручное управление «Сейчас выступает».
--
-- ЗАЧЕМ. По умолчанию текущий спикер определяется авто по таймингу слота программы
-- (conf_sessions). Но программа может «поехать» (спикер опоздал, затянулось). Тогда
-- ведущий должен сам ставить, кто сейчас выступает. speaker_mode:
--   auto   — по программе (как было);
--   manual — ведущий выбрал спикера руками (manual_speaker_ec_id).

BEGIN;

ALTER TABLE webinar_rooms
  ADD COLUMN IF NOT EXISTS speaker_mode TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS manual_speaker_ec_id INTEGER;  -- event_collaborators.id

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_rooms TO plusson;

COMMIT;
