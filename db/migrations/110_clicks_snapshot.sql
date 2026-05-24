-- Миграция 110 (2026-05-24): снапшот контакта в `event_collaborator_clicks`
--
-- Когда пользователь удаляет контакт (стирает ПД по 152-ФЗ), запись клика
-- остаётся, но `contact_id` обнуляется (ON DELETE SET NULL). В статистике
-- спикера такой клик показывается как «аноним» — теряется ценная инфа о
-- том, кто и с какой платформы кликнул.
--
-- Фикс — денормализация: при вставке клика копируем минимум полей контакта
-- (имя, tg_id/vk_id/max_id, tg_nickname). Эти поля переживают удаление
-- контакта и используются в UI как fallback.
--
-- Существующие клики (с обнулённым contact_id) восстановить нельзя — они
-- останутся «аноним» в истории, но новые будут показывать снапшот.

BEGIN;

ALTER TABLE event_collaborator_clicks
  ADD COLUMN IF NOT EXISTS contact_name TEXT,
  ADD COLUMN IF NOT EXISTS tg_id        TEXT,
  ADD COLUMN IF NOT EXISTS tg_nickname  TEXT,
  ADD COLUMN IF NOT EXISTS vk_id        TEXT,
  ADD COLUMN IF NOT EXISTS max_id       TEXT;

COMMENT ON COLUMN event_collaborator_clicks.contact_name IS
  'Снапшот contacts.name на момент клика. Используется если contact_id обнулён.';
COMMENT ON COLUMN event_collaborator_clicks.tg_id IS
  'Снапшот платформенного TG-ID кликнувшего. NULL если кликал не из TG.';
COMMENT ON COLUMN event_collaborator_clicks.tg_nickname IS
  'Снапшот TG-username (без @) на момент клика.';
COMMENT ON COLUMN event_collaborator_clicks.vk_id IS
  'Снапшот VK user_id кликнувшего.';
COMMENT ON COLUMN event_collaborator_clicks.max_id IS
  'Снапшот MAX user_id кликнувшего.';

-- Бэкфилл существующих записей с непустым contact_id — забираем поля из contacts/platform_users
UPDATE event_collaborator_clicks cl
   SET contact_name = c.name,
       tg_id        = (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1),
       tg_nickname  = (SELECT pu.username        FROM platform_users pu
                        WHERE pu.contact_id = c.id AND pu.platform_slug = 'telegram' LIMIT 1),
       vk_id        = (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id = c.id AND pu.platform_slug = 'vk' LIMIT 1),
       max_id       = (SELECT pu.platform_user_id FROM platform_users pu
                        WHERE pu.contact_id = c.id AND pu.platform_slug = 'max' LIMIT 1)
  FROM contacts c
 WHERE cl.contact_id = c.id;

COMMIT;
