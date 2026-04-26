-- ═══════════════════════════════════════════
-- Миграция 038: добавить квадратную ориентацию у афиш мероприятий
--
-- В миграции 035 был CHECK orientation IN ('horizontal','vertical').
-- Сейчас в карточке мероприятия добавляется третья зона — квадратные афиши
-- (как уже есть у конференций).
-- ═══════════════════════════════════════════

BEGIN;

ALTER TABLE event_posters DROP CONSTRAINT IF EXISTS event_posters_orientation_check;
ALTER TABLE event_posters
  ADD CONSTRAINT event_posters_orientation_check
  CHECK (orientation IN ('horizontal', 'vertical', 'square'));

COMMIT;
