-- ═══════════════════════════════════════════
-- Миграция 036: Иерархия Контактов
--
-- Создаём пять связанных таблиц:
--   platforms — справочник (telegram/vk/max + метаданные)
--   contacts — ЧЕЛОВЕК (один на клиента, ref_code, email, phone, теги)
--   platform_users — АККАУНТ человека на платформе (FK contact_id, platform_slug)
--   channels — каналы клиента (FK platform_slug)
--   platform_user_channels — подписка идентичности на канал (составные FK)
--
-- Переключаем event_participants и collaborators с platform_user_id на contact_id.
-- Реф-код переезжает из platform_users в contacts.
-- ═══════════════════════════════════════════

BEGIN;

-- ── 1. platforms (справочник) ───────────────
CREATE TABLE IF NOT EXISTS platforms (
    slug                TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    icon_url            TEXT,
    color_hex           TEXT,
    id_format           TEXT NOT NULL DEFAULT 'numeric',           -- numeric | string
    max_message_length  INTEGER NOT NULL DEFAULT 4000,
    supports_buttons    BOOLEAN NOT NULL DEFAULT TRUE,
    supports_photo      BOOLEAN NOT NULL DEFAULT TRUE,
    supports_video      BOOLEAN NOT NULL DEFAULT TRUE,
    api_base_url        TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platforms (slug, display_name, icon_url, color_hex, id_format, max_message_length, supports_buttons, supports_photo, supports_video, api_base_url, sort_order)
VALUES
    ('telegram', 'Telegram', '/icons/platforms/telegram.svg', '#229ED9', 'numeric', 4096, TRUE, TRUE, TRUE, 'https://api.telegram.org', 1),
    ('vk',       'VK',       '/icons/platforms/vk.svg',       '#0077FF', 'string',  4000, TRUE, TRUE, TRUE, 'https://api.vk.com/method',  2),
    ('max',      'MAX',      '/icons/platforms/max.svg',      '#FFCFA4', 'numeric', 4000, FALSE,TRUE, TRUE, NULL,                          3)
ON CONFLICT (slug) DO NOTHING;

-- ── 2. contacts (ЧЕЛОВЕК) ───────────────────
CREATE TABLE IF NOT EXISTS contacts (
    id                          SERIAL PRIMARY KEY,
    client_id                   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name                        TEXT,
    email                       TEXT,
    email_normalized            TEXT,                          -- lowercase + trim, для автомерджа
    phone                       TEXT,
    phone_normalized            TEXT,                          -- только цифры + 8→+7, для автомерджа
    tags                        JSONB NOT NULL DEFAULT '[]'::jsonb,
    utm_source                  TEXT,
    salebot_id                  TEXT,
    last_contact_at             TIMESTAMPTZ,
    ref_code                    VARCHAR(100) UNIQUE,
    first_referrer_contact_id   INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    first_referred_at           TIMESTAMPTZ,
    merged_into                 INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    merged_ref_codes            JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_client          ON contacts(client_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email_norm      ON contacts(client_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_phone_norm      ON contacts(client_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_salebot         ON contacts(salebot_id) WHERE salebot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_first_referrer  ON contacts(first_referrer_contact_id) WHERE first_referrer_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_active          ON contacts(client_id, is_active);

-- ── 3. Заполнение contacts из platform_users (1:1, ID совпадает) ──
-- Фокус: используем pu.id как contacts.id чтобы упростить переключение FK дальше
INSERT INTO contacts (id, client_id, name, email, email_normalized, phone, phone_normalized,
                      tags, utm_source, salebot_id, last_contact_at, ref_code,
                      created_at, updated_at)
SELECT
    pu.id,
    pu.client_id,
    NULLIF(TRIM(CONCAT_WS(' ', pu.first_name, pu.last_name)), ''),
    pu.email,
    LOWER(TRIM(pu.email)),
    pu.phone,
    CASE
        WHEN regexp_replace(COALESCE(pu.phone, ''), '[^0-9]', '', 'g') ~ '^8[0-9]{10}$'
            THEN '+7' || substring(regexp_replace(pu.phone, '[^0-9]', '', 'g') from 2)
        WHEN regexp_replace(COALESCE(pu.phone, ''), '[^0-9]', '', 'g') ~ '^7[0-9]{10}$'
            THEN '+' || regexp_replace(pu.phone, '[^0-9]', '', 'g')
        WHEN COALESCE(pu.phone, '') = '' THEN NULL
        ELSE regexp_replace(pu.phone, '[^0-9]', '', 'g')
    END,
    COALESCE(pu.tags, '[]'::jsonb),
    pu.utm_source,
    pu.salebot_id,
    pu.last_contact_at,
    pu.ref_code,
    pu.created_at,
    pu.updated_at
FROM platform_users pu
ORDER BY pu.id;

-- Сдвиг serial-последовательности contacts чтобы новые id не пересеклись
SELECT setval(pg_get_serial_sequence('contacts', 'id'),
              GREATEST((SELECT COALESCE(MAX(id), 0) FROM contacts), 1));

-- Заполнение first_referrer_contact_id из platform_users.first_referrer_ref_code
UPDATE contacts c
SET first_referrer_contact_id = ref_c.id
FROM platform_users pu
JOIN contacts ref_c ON ref_c.ref_code = pu.first_referrer_ref_code
WHERE c.id = pu.id
  AND pu.first_referrer_ref_code IS NOT NULL
  AND ref_c.id <> c.id;

-- ── 4. platform_users — рефакторинг ────────
-- Возвращаем platform_slug (было удалено в 034)
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS platform_slug TEXT;
UPDATE platform_users SET platform_slug = 'telegram' WHERE platform_slug IS NULL;
ALTER TABLE platform_users ALTER COLUMN platform_slug SET NOT NULL;
ALTER TABLE platform_users ADD CONSTRAINT platform_users_platform_slug_fk
    FOREIGN KEY (platform_slug) REFERENCES platforms(slug);

-- Добавляем contact_id (1:1 — pu.id = c.id)
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS contact_id INTEGER;
UPDATE platform_users SET contact_id = id WHERE contact_id IS NULL;
ALTER TABLE platform_users ALTER COLUMN contact_id SET NOT NULL;
ALTER TABLE platform_users ADD CONSTRAINT platform_users_contact_fk
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;

-- Новые UNIQUE-ключи
ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_client_id_platform_user_id_key;
ALTER TABLE platform_users ADD CONSTRAINT platform_users_contact_platform_unique
    UNIQUE (contact_id, platform_slug);
ALTER TABLE platform_users ADD CONSTRAINT platform_users_client_platform_uid_unique
    UNIQUE (client_id, platform_slug, platform_user_id);

-- Уникальность (id, platform_slug) — нужна для составного FK из platform_user_channels
ALTER TABLE platform_users ADD CONSTRAINT platform_users_id_platform_unique
    UNIQUE (id, platform_slug);

-- Удаляем поля, переехавшие в contacts
ALTER TABLE platform_users DROP COLUMN IF EXISTS email;
ALTER TABLE platform_users DROP COLUMN IF EXISTS phone;
ALTER TABLE platform_users DROP COLUMN IF EXISTS tags;
ALTER TABLE platform_users DROP COLUMN IF EXISTS utm_source;
ALTER TABLE platform_users DROP COLUMN IF EXISTS salebot_id;
ALTER TABLE platform_users DROP COLUMN IF EXISTS ref_code;
ALTER TABLE platform_users DROP COLUMN IF EXISTS first_referrer_ref_code;
ALTER TABLE platform_users DROP COLUMN IF EXISTS last_contact_at;

CREATE INDEX IF NOT EXISTS idx_platform_users_contact ON platform_users(contact_id);
CREATE INDEX IF NOT EXISTS idx_platform_users_platform ON platform_users(platform_slug);

-- ── 5. channels — переход на FK ─────────────
-- Снимаем CHECK-ограничение, переименовываем platform → platform_slug, добавляем FK
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_platform_check;
ALTER TABLE channels RENAME COLUMN platform TO platform_slug;
ALTER TABLE channels ADD CONSTRAINT channels_platform_slug_fk
    FOREIGN KEY (platform_slug) REFERENCES platforms(slug);

-- Уникальность (id, platform_slug) — для составного FK из platform_user_channels
ALTER TABLE channels ADD CONSTRAINT channels_id_platform_unique
    UNIQUE (id, platform_slug);

-- ── 6. platform_user_channels — добавляем platform_slug + составные FK ──
ALTER TABLE platform_user_channels ADD COLUMN IF NOT EXISTS platform_slug TEXT;

-- Заполняем из platform_users
UPDATE platform_user_channels puc
SET platform_slug = pu.platform_slug
FROM platform_users pu
WHERE puc.platform_user_id = pu.id
  AND puc.platform_slug IS NULL;

ALTER TABLE platform_user_channels ALTER COLUMN platform_slug SET NOT NULL;
ALTER TABLE platform_user_channels ADD CONSTRAINT puc_platform_slug_fk
    FOREIGN KEY (platform_slug) REFERENCES platforms(slug);

-- Снимаем простые FK на platform_users(id) и channels(id), ставим составные
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_platform_user_id_fkey;
ALTER TABLE platform_user_channels DROP CONSTRAINT IF EXISTS platform_user_channels_channel_id_fkey;

ALTER TABLE platform_user_channels ADD CONSTRAINT puc_platform_user_composite_fk
    FOREIGN KEY (platform_user_id, platform_slug)
    REFERENCES platform_users(id, platform_slug) ON DELETE CASCADE;

ALTER TABLE platform_user_channels ADD CONSTRAINT puc_channel_composite_fk
    FOREIGN KEY (channel_id, platform_slug)
    REFERENCES channels(id, platform_slug) ON DELETE CASCADE;

-- ── 7. event_participants — переход на contact_id ──
ALTER TABLE event_participants ADD COLUMN IF NOT EXISTS contact_id INTEGER;
UPDATE event_participants SET contact_id = platform_user_id WHERE contact_id IS NULL;
ALTER TABLE event_participants ALTER COLUMN contact_id SET NOT NULL;
ALTER TABLE event_participants ADD CONSTRAINT event_participants_contact_fk
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;

-- Старая уникальность по (event_id, platform_user_id) → новая по (event_id, contact_id)
ALTER TABLE event_participants DROP CONSTRAINT IF EXISTS event_participants_event_platform_user_key;
ALTER TABLE event_participants ADD CONSTRAINT event_participants_event_contact_unique
    UNIQUE (event_id, contact_id);

DROP INDEX IF EXISTS idx_event_participants_platform_user;
ALTER TABLE event_participants DROP COLUMN IF EXISTS platform_user_id;

CREATE INDEX IF NOT EXISTS idx_event_participants_contact ON event_participants(contact_id);

-- ── 8. collaborators — переход на contact_id ──
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS contact_id INTEGER;
UPDATE collaborators SET contact_id = platform_user_id WHERE contact_id IS NULL;
-- contact_id может быть NULL для старых коллабов без связи (миграция 032 заполнила не всё)
ALTER TABLE collaborators ADD CONSTRAINT collaborators_contact_fk
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS idx_collaborators_platform_user;
ALTER TABLE collaborators DROP COLUMN IF EXISTS platform_user_id;

CREATE INDEX IF NOT EXISTS idx_collaborators_contact ON collaborators(contact_id);

-- ── 9. broadcast_log — оставляем platform_user_id (лог per-identity) ──
-- Никаких изменений: log хранит факт отправки конкретному TG-аккаунту в конкретный канал.
-- Это привязано к platform_users (идентичности), не к contacts (человеку).

COMMIT;

-- ═══════════════════════════════════════════
-- Проверка после миграции (выполнять отдельно):
--
-- SELECT COUNT(*) FROM contacts;
-- SELECT COUNT(*) FROM platform_users WHERE contact_id IS NULL;          -- должно быть 0
-- SELECT COUNT(*) FROM event_participants WHERE contact_id IS NULL;      -- должно быть 0
-- SELECT COUNT(*) FROM platform_user_channels WHERE platform_slug IS NULL; -- должно быть 0
-- SELECT slug FROM platforms ORDER BY sort_order;                        -- telegram, vk, max
-- ═══════════════════════════════════════════
