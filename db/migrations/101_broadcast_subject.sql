-- 101_broadcast_subject.sql
-- Опциональное поле «Заголовок» (Subject) для шаблона рассылки.
-- - В email становится темой письма (поле Subject)
-- - В Telegram/VK/MAX идёт первой строкой жирным перед основным текстом
-- (если задан)

ALTER TABLE broadcast_templates
    ADD COLUMN IF NOT EXISTS subject TEXT;

COMMENT ON COLUMN broadcast_templates.subject IS
    'Заголовок: в email → Subject, в TG/VK/MAX → первая жирная строка';
