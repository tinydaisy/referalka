-- Миграция 049 — единый stream_url на событие
--
-- Раньше у конференций stream_url хранился в conf_days (per-день).
-- Унифицируем: теперь один stream_url на всё событие, как у обычных
-- событий с одним стримом. Колонка conf_days.stream_url пока ОСТАЁТСЯ,
-- чтобы не сломать существующие рассылки в полёте — удалим отдельной
-- миграцией после того, как Celery точно перейдёт на events.stream_url.

ALTER TABLE events ADD COLUMN IF NOT EXISTS stream_url TEXT;

-- Перенос данных: первый непустой stream_url из conf_days.
UPDATE events e
   SET stream_url = sub.first_url
  FROM (
    SELECT DISTINCT ON (event_id) event_id, stream_url AS first_url
      FROM conf_days
     WHERE stream_url IS NOT NULL AND stream_url <> ''
     ORDER BY event_id, day_number
  ) sub
 WHERE e.id = sub.event_id
   AND (e.stream_url IS NULL OR e.stream_url = '');
