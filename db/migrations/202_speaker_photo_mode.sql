-- Миграция 202: выбор источника фото в спикерских шаблонах рассылок.
-- speaker_photo_mode: 'poster' (афиша спикера из библиотеки, текущее поведение)
--                   | 'photo'  (просто фото коллаба — c.photo_url).
-- Применяется к типам speaker_intro / 5min_before / expert_day.
-- DEFAULT 'poster' сохраняет прежнее поведение для всех существующих шаблонов.

ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS speaker_photo_mode TEXT NOT NULL DEFAULT 'poster';

ALTER TABLE broadcast_templates
  DROP CONSTRAINT IF EXISTS broadcast_templates_speaker_photo_mode_check;
ALTER TABLE broadcast_templates
  ADD CONSTRAINT broadcast_templates_speaker_photo_mode_check
  CHECK (speaker_photo_mode IN ('poster', 'photo'));

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_templates TO plusson;
