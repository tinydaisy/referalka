-- ═══════════════════════════════════════════
-- Миграция 043: статусы событий — draft / published / ended
--
-- Возвращаем понятие черновика. Раньше (миграция 040) убирали draft
-- и делали все события сразу 'active'. Теперь:
--   - draft     — событие настраивается, в Mini App не показывается
--   - published — опубликовано, видно в Mini App (Календарь Хаба, лендинг)
--   - ended     — завершено
--
-- Переименовываем 'active' → 'published'. Дефолт — 'draft'.
-- Mini App продолжает скрывать события со status='draft'.
-- ═══════════════════════════════════════════

BEGIN;

UPDATE events SET status = 'published' WHERE status = 'active';

ALTER TABLE events ALTER COLUMN status SET DEFAULT 'draft';

COMMIT;
