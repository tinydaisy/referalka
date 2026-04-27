-- ═══════════════════════════════════════════
-- Миграция 039: Экосистема клиента (визитка) + продукты + successor_event
--
-- Что добавляет:
--   1. Поля визитки в `clients`: bio, profile_photo_url, positioning, achievements, social_links
--   2. Новая таблица `client_offerings` — продукты клиента (платные/бесплатные) для вкладки «Экосистема» в Mini App
--   3. Поле `events.successor_event_id` — какое событие предлагать после завершения текущего
--
-- Используется в Mini App:
--   • Хаб организатора → вкладка «🌐 Экосистема» (визитка + продукты)
--   • Экран события → состояние «Завершено» → блок «А дальше: следующее событие»
-- ═══════════════════════════════════════════

BEGIN;

-- ── 1. Поля визитки клиента ─────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS bio                TEXT,
  ADD COLUMN IF NOT EXISTS profile_photo_url  TEXT,
  ADD COLUMN IF NOT EXISTS positioning        TEXT,
  ADD COLUMN IF NOT EXISTS achievements       JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS social_links       JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN clients.bio                IS 'Биография клиента для вкладки Экосистема в Mini App';
COMMENT ON COLUMN clients.profile_photo_url  IS 'Фото клиента (R2 url) для шапки Экосистемы';
COMMENT ON COLUMN clients.positioning        IS 'Однострочное позиционирование: «основатель iVision Group, ментор...»';
COMMENT ON COLUMN clients.achievements       IS 'Массив [{label: "учеников", value: "1500+"}] — карточки регалий';
COMMENT ON COLUMN clients.social_links       IS 'JSON {instagram, telegram, youtube, vk, website} — соцсети для шапки';

-- ── 2. Таблица client_offerings — продукты ──
CREATE TABLE IF NOT EXISTS client_offerings (
    id           SERIAL PRIMARY KEY,
    client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    description  TEXT,
    action_url   TEXT,
    is_paid      BOOLEAN NOT NULL DEFAULT TRUE,
    cover_url    TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_offerings_client       ON client_offerings(client_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_client_offerings_client_paid  ON client_offerings(client_id, is_paid);

COMMENT ON TABLE  client_offerings IS 'Продукты клиента (курсы, консультации, материалы) для вкладки Экосистема в Mini App';
COMMENT ON COLUMN client_offerings.is_paid IS 'TRUE → блок «Платно», FALSE → блок «Бесплатно»';

-- ── 3. successor_event_id — переход на следующее событие ──
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS successor_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_successor ON events(successor_event_id) WHERE successor_event_id IS NOT NULL;

COMMENT ON COLUMN events.successor_event_id IS 'Какое событие предлагать на экране «Завершено» в Mini App';

COMMIT;
