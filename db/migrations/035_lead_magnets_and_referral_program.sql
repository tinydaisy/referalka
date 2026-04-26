-- ═══════════════════════════════════════════
-- Миграция 035: Лид-магниты + Реф-программа как вкладка события
--
-- Концепция (от 2026-04-25):
--   - Раздел «Рефералки» убирается. Реф-программа — это вкладка внутри карточки события.
--   - Лид-магниты — общая база per-client (один материал = одна запись).
--   - Афиши события — список с ориентацией, используются на лендинге, в шеринге.
--   - Пороги реф-программы — кол-во приведённых → лид-магнит + сертификат.
--   - Материалы реф-программы — что участник копирует и шерит друзьям.
--   - Шаблоны реф-программы — текст приветствия + текст выдачи каждого подарка.
-- ═══════════════════════════════════════════

BEGIN;

-- ── Расширение events ──────────────────────
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS address  TEXT,
  ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_events_start_at ON events(start_at) WHERE start_at IS NOT NULL;

-- ── Лид-магниты (общая база клиента) ───────
CREATE TABLE IF NOT EXISTS lead_magnets (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    url         TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_magnets_client ON lead_magnets(client_id);

-- ── Афиши события ──────────────────────────
CREATE TABLE IF NOT EXISTS event_posters (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    orientation TEXT NOT NULL DEFAULT 'horizontal' CHECK (orientation IN ('horizontal', 'vertical')),
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_posters_event ON event_posters(event_id, sort);

-- ── Реф-программа: общие настройки ─────────
CREATE TABLE IF NOT EXISTS event_referral_settings (
    id            SERIAL PRIMARY KEY,
    event_id      INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    welcome_text  TEXT,    -- текст приветствия (включает список всех подарков)
    share_text    TEXT,    -- текст-анонс для шеринга участником
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Реф-программа: пороги-подарки ──────────
CREATE TABLE IF NOT EXISTS event_referral_thresholds (
    id                  SERIAL PRIMARY KEY,
    event_id            INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    threshold_count     INTEGER NOT NULL,                -- 1, 3, 10, 50 — кол-во приведённых
    lead_magnet_id      INTEGER REFERENCES lead_magnets(id) ON DELETE SET NULL,
    certificate_url     TEXT,                            -- опц., картинка-сертификат
    gift_template_text  TEXT,                            -- текст выдачи от бота
    sort                INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, threshold_count)
);

CREATE INDEX IF NOT EXISTS idx_thresholds_event ON event_referral_thresholds(event_id, sort);

-- ── Реф-программа: материалы для шеринга ───
-- source = 'event_poster' (берём из event_posters) | 'custom' (загружено отдельно)
CREATE TABLE IF NOT EXISTS event_referral_materials (
    id                SERIAL PRIMARY KEY,
    event_id          INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    image_url         TEXT NOT NULL,
    source            TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('event_poster', 'custom')),
    source_poster_id  INTEGER REFERENCES event_posters(id) ON DELETE SET NULL,
    sort              INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_materials_event ON event_referral_materials(event_id, sort);

COMMIT;
