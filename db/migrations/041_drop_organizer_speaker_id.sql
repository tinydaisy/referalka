-- ═══════════════════════════════════════════
-- Миграция 041: удалить conf_conferences.organizer_speaker_id
--
-- Раньше у конференции было отдельное поле «Организатор события» —
-- ссылка на конкретного спикера, играющего роль организатора.
-- Это дублировало роль `conf_speaker_events.role = 'organizer'`.
-- Решение: организатором считается любой спикер с ролью 'organizer';
-- отдельное поле больше не нужно.
--
-- Поле было добавлено в миграции 006 (organizer_speaker_id INTEGER
-- REFERENCES speakers(id)). Сейчас FK на устаревшую таблицу `speakers`,
-- так что фактически никем не используется.
-- ═══════════════════════════════════════════

BEGIN;

ALTER TABLE conf_conferences DROP COLUMN IF EXISTS organizer_speaker_id;

COMMIT;
