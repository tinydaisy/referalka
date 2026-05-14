-- Миграция 077: медиа (фото/видео) в шаблоне воронки лид-магнита.
--
-- К Тексту 1 (приветствие) и Тексту 2 (выдача после подписки) клиент может
-- прикрепить одно фото или одно видео. По умолчанию NULL = шлём только текст.
--
-- При отправке логика:
--   - нет медиа → sendMessage (как сейчас);
--   - есть медиа и итоговый текст ≤ 1024 → sendPhoto/sendVideo с caption + inline-кнопкой;
--   - есть медиа и текст > 1024 → sendPhoto/sendVideo без caption + sendMessage отдельным сообщением.

ALTER TABLE funnel_templates
    ADD COLUMN IF NOT EXISTS text_1_media_url  TEXT,
    ADD COLUMN IF NOT EXISTS text_1_media_type TEXT,
    ADD COLUMN IF NOT EXISTS text_2_media_url  TEXT,
    ADD COLUMN IF NOT EXISTS text_2_media_type TEXT;

ALTER TABLE funnel_templates
    DROP CONSTRAINT IF EXISTS funnel_templates_text_1_media_type_check,
    DROP CONSTRAINT IF EXISTS funnel_templates_text_2_media_type_check;

ALTER TABLE funnel_templates
    ADD CONSTRAINT funnel_templates_text_1_media_type_check
        CHECK (text_1_media_type IS NULL OR text_1_media_type IN ('photo', 'video')),
    ADD CONSTRAINT funnel_templates_text_2_media_type_check
        CHECK (text_2_media_type IS NULL OR text_2_media_type IN ('photo', 'video'));
