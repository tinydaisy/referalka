-- 097_email_channel_foundation.sql
-- Введение email как полноценной платформы в систему каналов.
--
-- Что делает:
-- 1) Регистрирует платформу 'email' в platforms.
-- 2) Расширяет channels тремя полями для email-конфигурации:
--    email_subdomain  — поддомен клиента ('vasya' → vasya.pluson.ru).
--                       NULL для системного канала → шлёт от noreply@pluson.ru.
--    email_from_local — local-part адреса ('hello', 'noreply', 'info').
--    email_from_name  — имя отправителя в From-заголовке ('iVision Конференция').
--                       NULL → fallback на clients.brand_name при отправке.
-- 3) Создаёт ОДИН системный email-канал ПЛЮСОНа (noreply@pluson.ru).
-- 4) Привязывает его ко ВСЕМ существующим клиентам через client_channels
--    с is_active=TRUE (это первый email-канал у каждого клиента, он же
--    становится главным до тех пор пока клиент не настроит собственный).
-- 5) BACKFILL: для каждого contacts.email создаёт platform_users(email)
--    + подписку в platform_user_channels на главный email-канал клиента.
--    Это критично: после миграции у всех существующих контактов с email
--    появляется полноценная email-идентичность + подписка.
--
-- Идемпотентность: все INSERT с ON CONFLICT DO NOTHING.

BEGIN;

-- ─────────────────────────────────────────────────────
-- 1. Платформа 'email'
-- ─────────────────────────────────────────────────────
INSERT INTO platforms (
    slug, display_name, color_hex, id_format,
    max_message_length, supports_buttons, supports_photo, supports_video,
    sort_order
)
VALUES (
    'email', 'Email', '#3D8CB6', 'string',
    100000, FALSE, TRUE, FALSE,
    50
)
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- 2. Расширение channels — поля для email-конфигурации
-- ─────────────────────────────────────────────────────
ALTER TABLE channels ADD COLUMN IF NOT EXISTS email_subdomain TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS email_from_local TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS email_from_name TEXT;

-- Формат поддомена: только латиница, цифры, дефисы. Без двойных дефисов.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_email_subdomain_format'
    ) THEN
        ALTER TABLE channels ADD CONSTRAINT chk_email_subdomain_format
            CHECK (
                email_subdomain IS NULL
                OR email_subdomain ~ '^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$'
            );
    END IF;
END$$;

-- Формат local-part: латиница, цифры, точки, дефисы.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_email_from_local_format'
    ) THEN
        ALTER TABLE channels ADD CONSTRAINT chk_email_from_local_format
            CHECK (
                email_from_local IS NULL
                OR email_from_local ~ '^[a-z0-9.-]+$'
            );
    END IF;
END$$;

-- Уникальность поддомена — один subdomain ↔ один канал глобально
CREATE UNIQUE INDEX IF NOT EXISTS uniq_channels_email_subdomain
    ON channels(email_subdomain)
    WHERE email_subdomain IS NOT NULL;

-- ─────────────────────────────────────────────────────
-- 3. Системный email-канал ПЛЮСОНа
-- ─────────────────────────────────────────────────────
-- email_subdomain=NULL → шлёт с apex pluson.ru → noreply@pluson.ru
-- email_from_name=NULL → подставляем clients.brand_name динамически при отправке
-- handle хранит финальный адрес для удобства отображения в дашборде
INSERT INTO channels (
    platform_slug, display_name, handle, bot_token,
    is_system, is_test,
    email_subdomain, email_from_local, email_from_name,
    platform_meta
)
VALUES (
    'email', 'Системный Email ПЛЮСОНа', 'noreply@pluson.ru', '',
    TRUE, FALSE,
    NULL, 'noreply', NULL,
    '{}'::jsonb
)
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────
-- 4. Привязка системного email-канала ко всем клиентам
-- ─────────────────────────────────────────────────────
-- is_active=TRUE — это первый и единственный email-канал у каждого клиента,
-- он становится главным. Если клиент в будущем создаст собственный
-- (со своим поддоменом) — главным станет тот, системный деактивируется.
INSERT INTO client_channels (client_id, channel_id, is_active)
SELECT c.id, ch.id, TRUE
FROM clients c
CROSS JOIN channels ch
WHERE ch.platform_slug = 'email'
  AND ch.is_system = TRUE
  AND ch.handle = 'noreply@pluson.ru'
ON CONFLICT (client_id, channel_id) DO NOTHING;

-- ─────────────────────────────────────────────────────
-- 5. BACKFILL platform_users(email) для всех contacts.email
-- ─────────────────────────────────────────────────────
-- platform_user_id = нормализованный email (lowercase, trim).
-- first_name = имя контакта (для подстановки {first_name} в письмах).
-- ON CONFLICT — покрывает оба UNIQUE-конфликта (contact_id+platform,
-- client_id+platform+platform_user_id).
INSERT INTO platform_users (
    contact_id, client_id, platform_slug, platform_user_id,
    first_name
)
SELECT
    c.id,
    c.client_id,
    'email',
    LOWER(TRIM(c.email)),
    c.name
FROM contacts c
WHERE c.email IS NOT NULL
  AND TRIM(c.email) <> ''
  AND c.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────
-- 6. BACKFILL platform_user_channels — подписка на главный email-канал
-- ─────────────────────────────────────────────────────
-- Каждая email-идентичность подписывается на активный email-канал клиента
-- (после шагов 3-4 это системный канал ПЛЮСОНа).
-- subscribed_at=NOW(), is_unsubscribed=FALSE (по умолчанию).
INSERT INTO platform_user_channels (
    platform_user_id, client_channel_id, subscribed_at
)
SELECT
    pu.id,
    cc.id,
    NOW()
FROM platform_users pu
JOIN client_channels cc ON cc.client_id = pu.client_id
JOIN channels ch ON ch.id = cc.channel_id
WHERE pu.platform_slug = 'email'
  AND ch.platform_slug = 'email'
  AND cc.is_active = TRUE
ON CONFLICT DO NOTHING;

COMMIT;

-- Контрольные запросы (выводят итоги в логи psql):
-- SELECT COUNT(*) AS email_platform_users FROM platform_users WHERE platform_slug='email';
-- SELECT COUNT(*) AS email_subscriptions FROM platform_user_channels puc
--   JOIN client_channels cc ON cc.id=puc.client_channel_id
--   JOIN channels ch ON ch.id=cc.channel_id WHERE ch.platform_slug='email';
