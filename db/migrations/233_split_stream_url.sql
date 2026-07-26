-- 233: удаляем перегруженное events.stream_url.
-- Ссылка эфира теперь ВЕЗДЕ = вебинарная комната (webinar_rooms по дню):
--   • мероприятие (всегда 1 день) → комната дня 1;
--   • конференция / турнир         → комната соответствующего дня;
--   • сторонняя комната            → её external_url.
-- Конкурс stream_url означал ссылку голосования = сторонний лендинг → переносим в landing_url.
-- Новых полей НЕ заводим. После переноса events.stream_url УДАЛЯЕТСЯ.

UPDATE events SET landing_url = stream_url
 WHERE module_slug = 'contest'
   AND (landing_url IS NULL OR landing_url = '')
   AND stream_url IS NOT NULL AND stream_url <> '';

ALTER TABLE events DROP COLUMN IF EXISTS stream_url;

GRANT SELECT, INSERT, UPDATE, DELETE ON events TO plusson;
