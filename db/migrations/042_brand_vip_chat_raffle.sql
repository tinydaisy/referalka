-- ═══════════════════════════════════════════
-- Миграция 042: Бренд клиента + VIP/Чат конференции + Призы розыгрыша
--
-- Что добавляет:
--   1. clients.brand_name — название бренда (iVISION). Owner_role и регалии уже в clients (positioning, achievements).
--   2. events VIP-поля (для конференции): has_vip_tariff, vip_price, vip_url, vip_title, vip_description
--   3. events.chat_url + events.chat_subscriptions_required — общий чат (только для конференции)
--   4. event_referral_settings.gift_count_mode — за что считать подарки: registered (default) / visited
--   5. event_raffle_settings — общие настройки розыгрыша на событие
--   6. event_raffle_prizes — призы розыгрыша (карточки в Mini App)
--   7. event_raffle_keywords — кодовые слова за билеты
--
-- Применяется к мероприятиям и конференциям. VIP/Чат — только конференции.
-- ═══════════════════════════════════════════

BEGIN;

-- ── 1. Название бренда клиента ──────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS brand_name TEXT;

COMMENT ON COLUMN clients.brand_name IS 'Название бренда клиента, отображается крупно в Экосистеме (например iVISION). Если NULL — fallback на owner_name';

-- ── 2. VIP-тариф события (для конференции) ──
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS has_vip_tariff BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vip_price      INTEGER,
  ADD COLUMN IF NOT EXISTS vip_url        TEXT,
  ADD COLUMN IF NOT EXISTS vip_title      TEXT,
  ADD COLUMN IF NOT EXISTS vip_description TEXT;

COMMENT ON COLUMN events.has_vip_tariff IS 'Если TRUE — в Mini App показывается кнопка ВИП-тарифа над программой и в Итогах';
COMMENT ON COLUMN events.vip_price      IS 'Цена ВИП в рублях (целое число). 29000 = 29 000 ₽';
COMMENT ON COLUMN events.vip_url        IS 'Ссылка для оплаты ВИП (внешняя)';
COMMENT ON COLUMN events.vip_title      IS 'Название ВИП-тарифа (по умолчанию «VIP-доступ»)';

-- ── 3. Чат события + требование подписки ────
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS chat_url TEXT,
  ADD COLUMN IF NOT EXISTS chat_subscriptions_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chat_member_count_label TEXT;

COMMENT ON COLUMN events.chat_url                    IS 'Ссылка на общий чат события (только для конференций)';
COMMENT ON COLUMN events.chat_subscriptions_required IS 'TRUE → доступ к чату только после подписки на спикеров и организатора';
COMMENT ON COLUMN events.chat_member_count_label     IS 'Статичная подпись для чата: "900+ человек". Настраивается клиентом, не считается автоматически';

-- ── 4. Логика подсчёта подарков (registered / visited) ──
ALTER TABLE event_referral_settings
  ADD COLUMN IF NOT EXISTS gift_count_mode TEXT NOT NULL DEFAULT 'registered'
    CHECK (gift_count_mode IN ('registered', 'visited'));

COMMENT ON COLUMN event_referral_settings.gift_count_mode IS 'За что считать подарки: registered (только зарегистрированные) или visited (любые переходы)';

-- ── 5. Настройки розыгрыша на событие ───────
CREATE TABLE IF NOT EXISTS event_raffle_settings (
    id                                SERIAL PRIMARY KEY,
    event_id                          INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    is_enabled                        BOOLEAN NOT NULL DEFAULT FALSE,
    draw_at                           TIMESTAMPTZ,
    subscription_grants_starter_ticket BOOLEAN NOT NULL DEFAULT TRUE,
    intro_text                        TEXT,
    created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  event_raffle_settings IS 'Настройки розыгрыша на конкретное событие (включён/нет, время финала, выдача стартового билета за подписку)';

-- ── 6. Призы розыгрыша ──────────────────────
CREATE TABLE IF NOT EXISTS event_raffle_prizes (
    id            SERIAL PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    description   TEXT,
    icon_emoji    TEXT,
    icon_url      TEXT,
    places_count  INTEGER NOT NULL DEFAULT 1,
    value_label   TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raffle_prizes_event ON event_raffle_prizes(event_id, sort_order) WHERE is_active = TRUE;

COMMENT ON TABLE  event_raffle_prizes IS 'Призы розыгрыша (отображаются в Mini App в раскрывающемся блоке)';
COMMENT ON COLUMN event_raffle_prizes.places_count IS 'Сколько мест разыгрывается. Используется в подписи "1 место" / "5 мест"';
COMMENT ON COLUMN event_raffle_prizes.value_label  IS 'Опц.: оценка стоимости приза, например "89 000 ₽" — для дополнительной строки';

-- ── 7. Кодовые слова для билетов ────────────
CREATE TABLE IF NOT EXISTS event_raffle_keywords (
    id              SERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    keyword         TEXT NOT NULL,
    keyword_lower   TEXT NOT NULL,
    tickets_reward  INTEGER NOT NULL DEFAULT 1,
    max_uses        INTEGER,
    used_count      INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raffle_keywords_event_lower ON event_raffle_keywords(event_id, keyword_lower);
CREATE INDEX IF NOT EXISTS idx_raffle_keywords_event ON event_raffle_keywords(event_id, sort_order) WHERE is_active = TRUE;

COMMENT ON TABLE event_raffle_keywords IS 'Кодовые слова за билеты розыгрыша. Сравнение case-insensitive по keyword_lower';

-- ── 8. UNIQUE индекс на channels для одного активного канала per платформа ──
CREATE UNIQUE INDEX IF NOT EXISTS channels_client_platform_active_uniq
  ON channels (client_id, platform_slug)
  WHERE is_active = TRUE;

COMMENT ON INDEX channels_client_platform_active_uniq IS 'Один активный канал per платформа per клиент. Старый можно деактивировать (is_active=false), новый создать с тем же platform_slug';

COMMIT;
