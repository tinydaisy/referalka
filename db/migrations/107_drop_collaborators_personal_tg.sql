-- 107_drop_collaborators_personal_tg.sql
-- 2026-05-24
--
-- Личные TG-идентичности коллаба (personal_tg_id / personal_tg_username) больше
-- НЕ хранятся в collaborators. Они всегда живут в platform_users через
-- collaborators.contact_id → contacts.id → platform_users(contact_id, platform_slug='telegram').
--
-- Эта миграция:
--   1) Защитный бэкфилл — INSERT в platform_users для тех коллабов, у кого
--      personal_tg_id есть, но parallel-записи в platform_users нет
--      (по фактическим данным dev/prod таких уже нет — миграция 086 их синхронизировала).
--   2) Дозаполнение username в platform_users из collaborators, если в platform_users пусто.
--   3) Удаление CHECK-constraint и колонок personal_tg_id / personal_tg_username.
--
-- НЕ удаляем: tg_channel_url, tg_channel_id, assistant_tg_username, instagram_url — это
-- не личные идентичности, а публичные ссылки и поле ассистента.

BEGIN;

-- 1. Защитный бэкфилл: добавить platform_users для коллабов, где её нет.
INSERT INTO platform_users (client_id, contact_id, platform_slug, platform_user_id, username, created_at)
SELECT c.created_by_client_id,
       c.contact_id,
       'telegram',
       c.personal_tg_id,
       NULLIF(c.personal_tg_username, ''),
       NOW()
  FROM collaborators c
 WHERE c.personal_tg_id IS NOT NULL
   AND c.created_by_client_id IS NOT NULL
   AND c.contact_id IS NOT NULL
   AND NOT EXISTS (
       SELECT 1 FROM platform_users pu
        WHERE pu.contact_id = c.contact_id
          AND pu.platform_slug = 'telegram'
   )
ON CONFLICT (client_id, platform_slug, platform_user_id) DO NOTHING;

-- 2. Дозаполнить username в platform_users из collaborators, если в pu пусто.
UPDATE platform_users pu
   SET username = c.personal_tg_username
  FROM collaborators c
 WHERE pu.contact_id = c.contact_id
   AND pu.platform_slug = 'telegram'
   AND (pu.username IS NULL OR pu.username = '')
   AND c.personal_tg_username IS NOT NULL
   AND c.personal_tg_username <> '';

-- 3. Снести CHECK-constraint, привязанный к колонке.
ALTER TABLE collaborators DROP CONSTRAINT IF EXISTS chk_collaborator_tg_id_positive;

-- 4. Удалить колонки. С этого момента личный TG читается ТОЛЬКО через platform_users.
ALTER TABLE collaborators DROP COLUMN IF EXISTS personal_tg_id;
ALTER TABLE collaborators DROP COLUMN IF EXISTS personal_tg_username;

COMMIT;
