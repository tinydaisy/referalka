-- 102_broadcast_schedule_subject.sql
-- Заголовок (Subject) для общих рассылок (broadcast_schedules.snapshot_subject).
-- В email — становится темой письма. В TG/VK/MAX — первой жирной строкой.

ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS snapshot_subject TEXT;

COMMENT ON COLUMN broadcast_schedules.snapshot_subject IS
    'Заголовок для custom-рассылок: email Subject + первая жирная строка TG/VK/MAX';
