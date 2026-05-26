-- 113_event_and_collaborator_video.sql
-- 2026-05-25
--
-- Видеоматериалы для скачивания спикерами:
--   events.video_url       — общее видео события (один файл)
--   collaborators.video_url — индивидуальное видео коллаборатора (один файл, глобальное)
--
-- Аналогия с афишами (event_posters / collaborators.poster_url):
-- общее видео отдаётся всем спикерам события, индивидуальное — только своему
-- спикеру через мини-кабинет. Видео НЕ ресайзятся (хранятся как есть в R2);
-- ограничение размера — на стороне upload-эндпоинта.

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS video_url TEXT;

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS video_url TEXT;

COMMIT;
