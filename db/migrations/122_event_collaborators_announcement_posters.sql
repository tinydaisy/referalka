-- 122_event_collaborators_announcement_posters.sql
-- 2026-05-29
--
-- На странице спикера конференции клиент отмечает какие афиши из библиотеки
-- коллаба «использовать для анонсов» — спикер увидит их у себя в кабинете
-- (в разделе «Афиши для анонсов») и скачает для распространения в своих
-- каналах. Это per-event настройка — в разных конференциях клиент может
-- отметить разный набор.
--
-- Отдельно живёт `event_collaborators.poster_id` (миграция 121) — одна
-- афиша для рассылок бота в этой конференции.
--
-- Хранение: массив FK на `collaborator_posters.id`. CHECK-констрейнт на
-- массив с FK в PostgreSQL не поддерживается — валидация на бэке
-- (что все ID принадлежат тому же speaker_id).

BEGIN;

ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS announcement_poster_ids INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[];

COMMIT;
