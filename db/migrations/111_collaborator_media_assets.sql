-- 111_collaborator_media_assets.sql
-- 2026-05-25
--
-- Медийные активы коллаборатора — массив объектов {platform, subscribers}.
-- Платформы фиксированы: tg, youtube, vk, tiktok, instagram, max, rutube.
-- Используется как в карточке коллаборатора в дашборде, так и в self-service
-- кабинете спикера. Доступно во всех публичных endpoint'ах для сторонних
-- лендингов.

BEGIN;

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS media_assets JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Базовая валидация: всегда JSON-массив (а не объект/null/строка).
ALTER TABLE collaborators
  DROP CONSTRAINT IF EXISTS collaborators_media_assets_is_array;
ALTER TABLE collaborators
  ADD CONSTRAINT collaborators_media_assets_is_array
  CHECK (jsonb_typeof(media_assets) = 'array');

COMMIT;
