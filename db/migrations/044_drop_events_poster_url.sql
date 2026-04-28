-- ═══════════════════════════════════════════
-- Миграция 044: удаляем events.poster_url, всё через event_posters
--
-- Поле events.poster_url осталось от первой схемы (миграция 001), когда у
-- события была одна афиша. После миграций 035 (event_posters) и 038
-- (поддержка square) — все афиши лежат в event_posters с ориентациями
-- (square / horizontal / vertical), и UI пишет туда. Поле events.poster_url
-- никто из UI больше не записывает; оно работало только как fallback в API.
--
-- Шаги:
--   1. Для событий, у которых есть events.poster_url, но в event_posters нет
--      ни одной записи — переносим: создаём horizontal-афишу с этим URL.
--   2. Дропаем колонку events.poster_url.
-- ═══════════════════════════════════════════

BEGIN;

INSERT INTO event_posters (event_id, url, orientation, sort)
SELECT e.id, e.poster_url, 'horizontal', 0
  FROM events e
 WHERE e.poster_url IS NOT NULL
   AND e.poster_url <> ''
   AND NOT EXISTS (SELECT 1 FROM event_posters ep WHERE ep.event_id = e.id);

ALTER TABLE events DROP COLUMN poster_url;

COMMIT;
