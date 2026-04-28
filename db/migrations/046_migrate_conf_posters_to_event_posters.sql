-- 046: афиши конференций — единый источник истины event_posters
--
-- До этой миграции карточка конференции в дашборде писала афиши в
-- conf_conferences.poster_horizontal / poster_vertical / poster_square (массивы text[]),
-- а Mini App, лендинг и обычные мероприятия читают из event_posters.
-- Из-за этого новые загрузки на конференции не отображались в Mini App.
--
-- Миграция:
--   1) переносит все URL из conf_conferences.poster_* в event_posters (если их там ещё нет);
--   2) чистит мёртвые URL referalka.tinydaisy.dev (старая дев-машина, не существует),
--      попавшие в event_posters миграцией 044 из удалённой колонки events.poster_url.
-- Колонки conf_conferences.poster_* пока оставляем — на них завязаны рассылки
-- (message_builder с legacy-фоллбеком). Удаление колонок — отдельной миграцией позже.

BEGIN;

-- 1. Переносим существующие афиши из conf_conferences в event_posters
--    (без дубликатов: проверяем по совпадению event_id + url)

INSERT INTO event_posters (event_id, url, orientation, sort)
SELECT cc.event_id, u.url, 'horizontal', 0
  FROM conf_conferences cc, unnest(cc.poster_horizontal) AS u(url)
 WHERE NOT EXISTS (
       SELECT 1 FROM event_posters ep
        WHERE ep.event_id = cc.event_id AND ep.url = u.url
 );

INSERT INTO event_posters (event_id, url, orientation, sort)
SELECT cc.event_id, u.url, 'vertical', 0
  FROM conf_conferences cc, unnest(cc.poster_vertical) AS u(url)
 WHERE NOT EXISTS (
       SELECT 1 FROM event_posters ep
        WHERE ep.event_id = cc.event_id AND ep.url = u.url
 );

INSERT INTO event_posters (event_id, url, orientation, sort)
SELECT cc.event_id, u.url, 'square', 0
  FROM conf_conferences cc, unnest(cc.poster_square) AS u(url)
 WHERE NOT EXISTS (
       SELECT 1 FROM event_posters ep
        WHERE ep.event_id = cc.event_id AND ep.url = u.url
 );

-- 2. Чистим мёртвые URL: referalka.tinydaisy.dev — мой старый dev-домен,
--    который больше не резолвится. Эти записи попали в event_posters
--    миграцией 044 из старой колонки events.poster_url, а файлы никогда
--    не были на R2.

DELETE FROM event_posters
 WHERE url LIKE '%tinydaisy.dev%';

COMMIT;
