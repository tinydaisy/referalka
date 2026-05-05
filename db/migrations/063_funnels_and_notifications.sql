-- Миграция 063 (05.05.2026): шаблоны воронок, забеги воронок, канал уведомлений организатору
--
-- Архитектура воронок (тип 'lead_magnet'):
--   funnel_templates — один шаблон на (клиент, тип). Авто-создаётся при первом GET.
--                      Хранит 4 редактируемых текста (text_1, text_2, text_3_delivered,
--                      text_3_stuck) и подпись кнопки. Создание новых шаблонов нельзя —
--                      только править существующий. Шаблоны на клиента, не per-магнит.
--
--   funnel_runs    — каждый запуск воронки конкретным человеком на конкретный
--                    лид-магнит/пакет. Источник = magnet_id ИЛИ package_id (один из).
--                    stage прогрессирует: landed → started → subscribed → delivered.
--                    text3_kind проставляется когда отправили Текст 3
--                    ('delivered' для подписавшихся, 'stuck' для зависших).
--
-- Канал уведомлений организатору (clients.notifications_telegram_chat_id):
--   chat_id канала Telegram, в который @pluson_bot шлёт «новый интерес: <магнит>».
--   NULL = уведомления не настроены, не шлём.

BEGIN;

-- 1. Шаблоны воронок
CREATE TABLE IF NOT EXISTS funnel_templates (
    id                BIGSERIAL PRIMARY KEY,
    client_id         INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    type              TEXT NOT NULL CHECK (type IN ('lead_magnet')),
    text_1            TEXT NOT NULL,
    button_label      TEXT NOT NULL,
    text_2            TEXT NOT NULL,
    text_3_delivered  TEXT NOT NULL,
    text_3_stuck      TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, type)
);

-- 2. Забеги воронок
CREATE TABLE IF NOT EXISTS funnel_runs (
    id                     BIGSERIAL PRIMARY KEY,
    client_id              INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    type                   TEXT NOT NULL CHECK (type IN ('lead_magnet')),
    -- источник (один из двух обязателен)
    lead_magnet_id         INT REFERENCES lead_magnets(id) ON DELETE CASCADE,
    package_id             BIGINT REFERENCES lead_magnet_packages(id) ON DELETE CASCADE,
    -- кто пришёл
    contact_id             BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    platform_slug          TEXT REFERENCES platforms(slug),
    platform_user_id       TEXT,
    -- кто привёл
    referrer_contact_id    BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    -- метки
    utm                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- этап
    stage                  TEXT NOT NULL DEFAULT 'landed'
                           CHECK (stage IN ('landed', 'started', 'subscribed', 'delivered')),
    -- временные метки этапов
    landed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at             TIMESTAMPTZ,
    subscribed_at          TIMESTAMPTZ,
    delivered_at           TIMESTAMPTZ,
    -- текст 3
    text3_sent_at          TIMESTAMPTZ,
    text3_kind             TEXT CHECK (text3_kind IN ('delivered', 'stuck')),
    -- идентификатор сообщения text_1 (для редактирования inline-кнопки)
    last_message_id        BIGINT,
    -- ровно один источник
    CHECK ((lead_magnet_id IS NOT NULL)::int + (package_id IS NOT NULL)::int = 1)
);

CREATE INDEX IF NOT EXISTS funnel_runs_client_idx ON funnel_runs(client_id);
CREATE INDEX IF NOT EXISTS funnel_runs_lm_idx ON funnel_runs(lead_magnet_id) WHERE lead_magnet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS funnel_runs_pkg_idx ON funnel_runs(package_id) WHERE package_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS funnel_runs_contact_idx ON funnel_runs(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS funnel_runs_pending_text3_idx
    ON funnel_runs(stage)
 WHERE text3_sent_at IS NULL AND stage IN ('started', 'subscribed', 'delivered');

-- Резолв «один и тот же человек на один и тот же магнит» — для апсертов воронок
CREATE UNIQUE INDEX IF NOT EXISTS funnel_runs_unique_per_lm
    ON funnel_runs(client_id, platform_slug, platform_user_id, lead_magnet_id)
 WHERE lead_magnet_id IS NOT NULL AND platform_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS funnel_runs_unique_per_pkg
    ON funnel_runs(client_id, platform_slug, platform_user_id, package_id)
 WHERE package_id IS NOT NULL AND platform_user_id IS NOT NULL;

-- 3. Канал уведомлений организатору
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS notifications_telegram_chat_id BIGINT;

COMMENT ON COLUMN clients.notifications_telegram_chat_id IS
  'chat_id Telegram-канала, куда @pluson_bot шлёт уведомления организатору (например, «новый интерес на лид-магнит»). NULL = не настроено.';

COMMIT;
