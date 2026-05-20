-- Миграция 087 (2026-05-20) — JSONB поле platform_meta в channels.
--
-- Зачем. Для VK-сообщества клиенту нужно хранить кроме access_token (bot_token) ещё:
--   vk_app_id      — ID VK Mini App
--   vk_secure_key  — secure key для валидации подписи launch params
--   vk_group_id    — id сообщества (длинное число, для groups.* методов)
-- Для TG поле остаётся пустым ('{}').
--
-- Это легче добавлять отдельные колонки vk_*: завтра придёт MAX со своим набором,
-- послезавтра ещё что-то — JSONB даёт расширяемость без миграций per-платформа.
--
-- Совместимость: NULL не используем (DEFAULT '{}'::jsonb), читатели могут смело
-- делать platform_meta->>'vk_app_id' без NULL-проверок.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS platform_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN channels.platform_meta IS
  'Платформо-зависимые метаданные канала. Для VK: {vk_app_id, vk_secure_key, vk_group_id}. Для TG/MAX — пусто.';
