-- Миграция 020: fire_at может быть NULL (для speaker_intro черновиков)
ALTER TABLE broadcast_schedules ALTER COLUMN fire_at DROP NOT NULL;
