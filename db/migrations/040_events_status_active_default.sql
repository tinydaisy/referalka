-- ═══════════════════════════════════════════
-- Миграция 040: события создаются сразу как 'active'
--
-- Раньше все новые события создавались со статусом 'draft' и в UI
-- отображалась плашка «Черновик» с кнопкой «Активировать».
-- Бизнесу не нужна стадия draft — клиент сразу хочет видеть событие
-- в Mini App / на лендинге.
--
-- Меняем дефолт колонки status на 'active' и переключаем все
-- существующие 'draft' в 'active'.
-- ═══════════════════════════════════════════

BEGIN;

ALTER TABLE events ALTER COLUMN status SET DEFAULT 'active';

UPDATE events SET status = 'active' WHERE status = 'draft' OR status IS NULL;

COMMIT;
