-- Миграция 127: видео в рассылках (произвольных и шаблонных).
--
-- Раньше к рассылке можно было прикрепить только фото (broadcast_schedules.snapshot_photo,
-- broadcast_templates.photo_url). Теперь — фото ИЛИ видео.
--
-- Telegram: видео уходит встроенным плеером через sendVideo. Чтобы не качать
-- файл с R2 на каждого получателя, после первой отправки кешируем file_id
-- (snapshot_video_file_id / video_file_id) — дальше всем шлём по file_id мгновенно.
--
-- VK/MAX: видео файлом (нативная загрузка), при неудаче — fallback на текст+ссылку.
-- Email: всегда ссылка.
--
-- media_type определяет, чем считать вложение:
--   NULL  → нет медиа (или только текст)
--   photo → фото (старое поведение, snapshot_photo / photo_url)
--   video → видео (snapshot_video / video_url)

-- ── broadcast_schedules (произвольные рассылки + снапшоты шаблонных) ──
ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS snapshot_video         TEXT,
    ADD COLUMN IF NOT EXISTS snapshot_media_type    TEXT,
    ADD COLUMN IF NOT EXISTS snapshot_video_file_id TEXT;

ALTER TABLE broadcast_schedules
    DROP CONSTRAINT IF EXISTS broadcast_schedules_snapshot_media_type_check;
ALTER TABLE broadcast_schedules
    ADD CONSTRAINT broadcast_schedules_snapshot_media_type_check
        CHECK (snapshot_media_type IS NULL OR snapshot_media_type IN ('photo', 'video'));

-- ── broadcast_templates (шаблоны рассылок) ──
ALTER TABLE broadcast_templates
    ADD COLUMN IF NOT EXISTS video_url      TEXT,
    ADD COLUMN IF NOT EXISTS media_type     TEXT,
    ADD COLUMN IF NOT EXISTS video_file_id  TEXT;

ALTER TABLE broadcast_templates
    DROP CONSTRAINT IF EXISTS broadcast_templates_media_type_check;
ALTER TABLE broadcast_templates
    ADD CONSTRAINT broadcast_templates_media_type_check
        CHECK (media_type IS NULL OR media_type IN ('photo', 'video'));

-- Бэкфилл media_type='photo' там, где уже есть фото (для корректной отправки старых записей).
UPDATE broadcast_schedules
   SET snapshot_media_type = 'photo'
 WHERE snapshot_media_type IS NULL AND snapshot_photo IS NOT NULL AND snapshot_photo <> '';

UPDATE broadcast_templates
   SET media_type = 'photo'
 WHERE media_type IS NULL AND photo_url IS NOT NULL AND photo_url <> '';
