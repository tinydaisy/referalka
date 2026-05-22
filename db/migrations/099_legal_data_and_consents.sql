-- 099_legal_data_and_consents.sql
-- Юридические данные клиента + текст политики + версионирование +
-- согласия контактов (152-ФЗ).
--
-- Зачем:
-- 1. По 152-ФЗ оператор персональных данных обязан указать в политике своё
--    юр-лицо, ИНН, контакты. Для каждого клиента ПЛЮСОНа — своя политика.
-- 2. Согласие контакта на обработку перс-данных и маркетинг должно сохраняться
--    с датой, IP и версией политики (на случай обновления политики).

BEGIN;

-- ─────────────────────────────────────────────────────
-- 1. Юр-данные клиента
-- ─────────────────────────────────────────────────────
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS legal_form          TEXT,  -- 'individual' | 'ip' | 'ooo' | 'other'
    ADD COLUMN IF NOT EXISTS legal_name          TEXT,  -- ФИО или Наименование ИП/ООО
    ADD COLUMN IF NOT EXISTS legal_inn           TEXT,  -- ИНН (10 или 12 цифр)
    ADD COLUMN IF NOT EXISTS legal_ogrn          TEXT,  -- ОГРН/ОГРНИП (опционально)
    ADD COLUMN IF NOT EXISTS legal_address       TEXT,  -- Юр-адрес или адрес регистрации
    ADD COLUMN IF NOT EXISTS legal_operator_email TEXT, -- Контакт оператора перс-данных
    ADD COLUMN IF NOT EXISTS legal_operator_phone TEXT;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS privacy_policy_text       TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS privacy_policy_published_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS privacy_policy_version    INTEGER NOT NULL DEFAULT 0;


-- ─────────────────────────────────────────────────────
-- 2. История версий политики (для аудита согласий)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_policy_versions (
    id            BIGSERIAL PRIMARY KEY,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    text          TEXT    NOT NULL,
    published_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, version)
);

CREATE INDEX IF NOT EXISTS idx_client_policy_versions_client
    ON client_policy_versions(client_id, version DESC);


-- ─────────────────────────────────────────────────────
-- 3. Согласия контакта (152-ФЗ)
-- ─────────────────────────────────────────────────────
-- Храним прямо на contacts (1:1), потому что у контакта пара согласий
-- (на персданные + на маркетинг) и аудит каждого.
ALTER TABLE contacts
    -- Согласие на обработку персональных данных
    ADD COLUMN IF NOT EXISTS consent_pd_at         TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS consent_pd_ip         TEXT,
    ADD COLUMN IF NOT EXISTS consent_pd_policy_ver INTEGER,
    -- Согласие на маркетинговые рассылки
    ADD COLUMN IF NOT EXISTS consent_marketing_at         TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS consent_marketing_ip         TEXT,
    ADD COLUMN IF NOT EXISTS consent_marketing_policy_ver INTEGER;

CREATE INDEX IF NOT EXISTS idx_contacts_consent_marketing
    ON contacts(consent_marketing_at) WHERE consent_marketing_at IS NOT NULL;


-- ─────────────────────────────────────────────────────
-- 4. Токены для восстановления пароля (для транзакционки)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id           BIGSERIAL PRIMARY KEY,
    client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL,
    expires_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at      TIMESTAMP WITH TIME ZONE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ip_address   TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_reset_token_hash
    ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_unused
    ON password_reset_tokens(client_id, used_at)
    WHERE used_at IS NULL;


-- ─────────────────────────────────────────────────────
-- 5. Метка отправки уведомления о подписке за 7/3/1 день на email
-- ─────────────────────────────────────────────────────
-- В client_subscriptions уже есть notified_7d/3d/1d для TG-уведомления
-- организатору. Для email-уведомления самому клиенту — отдельные флаги.
ALTER TABLE client_subscriptions
    ADD COLUMN IF NOT EXISTS notified_email_7d BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS notified_email_3d BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS notified_email_1d BOOLEAN NOT NULL DEFAULT FALSE;


-- ─────────────────────────────────────────────────────
-- 6. Welcome-письмо для регистрации на событие
-- ─────────────────────────────────────────────────────
-- Один шаблон на каждое событие. Отправляется ОДИН раз каждому контакту
-- при первой регистрации (через лендинг, /r/{slug} или webhook).
-- Subject опциональный, для email становится темой; для TG/VK/MAX игнорируется.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS welcome_email_subject TEXT,
    ADD COLUMN IF NOT EXISTS welcome_text         TEXT,
    ADD COLUMN IF NOT EXISTS welcome_enabled      BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMP WITH TIME ZONE;

COMMIT;
