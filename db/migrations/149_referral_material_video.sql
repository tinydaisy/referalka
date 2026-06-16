-- 149: Видео в реферальных материалах для шеринга
--
-- Раньше event_referral_materials хранила только картинки (image_url NOT NULL).
-- Теперь материал может быть либо картинкой, либо видео.
--   media_type = 'image' (default) | 'video'
--   image_url  — для картинок (или обложка), nullable
--   video_url  — для видео
BEGIN;

ALTER TABLE event_referral_materials
    ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image'
        CHECK (media_type IN ('image', 'video')),
    ADD COLUMN IF NOT EXISTS video_url  TEXT;

-- image_url больше не обязателен (у видео-материала его может не быть)
ALTER TABLE event_referral_materials
    ALTER COLUMN image_url DROP NOT NULL;

-- Существующие записи — это картинки
UPDATE event_referral_materials SET media_type = 'image' WHERE media_type IS NULL;

COMMIT;
