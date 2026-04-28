-- 047: удалить легаси-колонки poster_horizontal/vertical/square из conf_conferences
--
-- Афиши лежат в event_posters (единый источник истины для всех событий, включая
-- конференции). Поля conf_conferences.poster_* — наследие со времён до event_posters,
-- они должны были быть удалены при создании event_posters, но остались, и из-за этого
-- фронт конференции писал афиши не в ту таблицу.
--
-- Перед запуском нужно убедиться, что:
--   1) данные перенесены в event_posters (миграция 046 это сделала);
--   2) код больше не читает и не пишет в эти колонки.
-- Оба условия выполнены.

BEGIN;

ALTER TABLE conf_conferences DROP COLUMN IF EXISTS poster_horizontal;
ALTER TABLE conf_conferences DROP COLUMN IF EXISTS poster_vertical;
ALTER TABLE conf_conferences DROP COLUMN IF EXISTS poster_square;

COMMIT;
