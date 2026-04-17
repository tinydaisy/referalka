-- Миграция 005: удаляем поля bio и company из таблицы speakers
ALTER TABLE speakers DROP COLUMN IF EXISTS bio;
ALTER TABLE speakers DROP COLUMN IF EXISTS company;
