-- 098_email_logs.sql
-- Логи для email-инфраструктуры:
-- 1. email_unsubscribe_log — каждое нажатие «отписаться» в письме
--    (для аудита и метрик качества рассылок клиента)
-- 2. email_bounce_log — возвраты от удалённых почтовиков
--    (для bounce-обработки: автоматическое отписывание битых адресов)
-- 3. email_open_log — открытия писем через tracking pixel
--    (для аналитики рассылок: open rate)
-- 4. email_click_log — клики по ссылкам в письмах
--    (для аналитики: click rate)

BEGIN;

-- Отписки от email-рассылок
CREATE TABLE IF NOT EXISTS email_unsubscribe_log (
    id                BIGSERIAL PRIMARY KEY,
    contact_id        BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    client_channel_id BIGINT NOT NULL REFERENCES client_channels(id) ON DELETE CASCADE,
    client_id         BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    ip_address        TEXT,
    user_agent        TEXT,
    unsubscribed_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_unsub_log_client     ON email_unsubscribe_log(client_id, unsubscribed_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_unsub_log_contact    ON email_unsubscribe_log(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_unsub_log_channel    ON email_unsubscribe_log(client_channel_id);


-- Bounce-возвраты (письмо не доставлено)
CREATE TABLE IF NOT EXISTS email_bounce_log (
    id            BIGSERIAL PRIMARY KEY,
    -- Канал клиента (через что слали). NULL если не получилось сопоставить
    client_channel_id BIGINT REFERENCES client_channels(id) ON DELETE SET NULL,
    client_id     BIGINT REFERENCES clients(id) ON DELETE CASCADE,
    -- Email-получатель (как был в From письма)
    to_email      TEXT NOT NULL,
    -- 'hard' (адрес не существует), 'soft' (временно), 'complaint' (жалоба)
    bounce_type   TEXT NOT NULL CHECK (bounce_type IN ('hard','soft','complaint','unknown')),
    smtp_code     TEXT,
    smtp_message  TEXT,
    raw_log       TEXT,
    bounced_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Был ли обработан (адрес отписан / контакт помечен битым)
    processed     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_email_bounce_log_to            ON email_bounce_log(to_email);
CREATE INDEX IF NOT EXISTS idx_email_bounce_log_client_when   ON email_bounce_log(client_id, bounced_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_bounce_log_unprocessed   ON email_bounce_log(processed) WHERE processed = FALSE;


-- Открытия писем (tracking pixel)
CREATE TABLE IF NOT EXISTS email_open_log (
    id                BIGSERIAL PRIMARY KEY,
    broadcast_log_id  BIGINT REFERENCES broadcast_log(id) ON DELETE CASCADE,
    contact_id        BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
    client_id         BIGINT REFERENCES clients(id) ON DELETE CASCADE,
    ip_address        TEXT,
    user_agent        TEXT,
    opened_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_open_log_broadcast ON email_open_log(broadcast_log_id);
CREATE INDEX IF NOT EXISTS idx_email_open_log_client    ON email_open_log(client_id, opened_at DESC);


-- Клики по ссылкам в письмах
CREATE TABLE IF NOT EXISTS email_click_log (
    id                BIGSERIAL PRIMARY KEY,
    broadcast_log_id  BIGINT REFERENCES broadcast_log(id) ON DELETE CASCADE,
    contact_id        BIGINT REFERENCES contacts(id) ON DELETE CASCADE,
    client_id         BIGINT REFERENCES clients(id) ON DELETE CASCADE,
    target_url        TEXT NOT NULL,
    ip_address        TEXT,
    user_agent        TEXT,
    clicked_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_click_log_broadcast ON email_click_log(broadcast_log_id);
CREATE INDEX IF NOT EXISTS idx_email_click_log_client    ON email_click_log(client_id, clicked_at DESC);


-- Отметка битых адресов прямо на platform_users — чтобы рассыльщик
-- мог быстро отфильтровать их одним JOIN'ом, не сходя в bounce_log.
-- Ставится cron-задачей обработки bounce-логов после hard bounce или
-- N последовательных soft bounces.
ALTER TABLE platform_users
    ADD COLUMN IF NOT EXISTS email_is_dead BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS email_dead_reason TEXT,
    ADD COLUMN IF NOT EXISTS email_dead_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_platform_users_email_dead
    ON platform_users(platform_slug) WHERE platform_slug = 'email' AND email_is_dead = TRUE;

COMMIT;
