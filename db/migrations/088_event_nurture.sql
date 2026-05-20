-- Миграция 088 (2026-05-20) — Воронка догрева для событий.
--
-- Триггер: человек впервые открыл событие через Mini App и НЕ зарегистрировался.
-- Воронка шлёт ему серию сообщений (по умолчанию 3: через 30 мин / 24 ч / 48 ч)
-- с напоминанием зарегистрироваться. Если человек регистрируется или событие
-- стартует — воронка останавливается.
--
-- Отличие от broadcast_schedules:
--   • broadcast_schedules — абсолютное время от events.start_at (за 2 ч до старта).
--     Все получают одновременно.
--   • event_nurture — относительное время от started_at (когда человек открыл).
--     Каждый получает в свой момент.

-- ───────────── Шаблоны шагов воронки (per-event, настраивается клиентом) ─────────────
CREATE TABLE IF NOT EXISTS event_nurture_steps (
    id              BIGSERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    offset_minutes  INTEGER NOT NULL,             -- через сколько минут после started_at
    text            TEXT    NOT NULL DEFAULT '',  -- HTML (<b>, <i>, <a>)
    button_label    TEXT    NOT NULL DEFAULT 'Зарегистрироваться',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (offset_minutes >= 0)
);
CREATE INDEX IF NOT EXISTS event_nurture_steps_event_idx
    ON event_nurture_steps (event_id, sort_order);

-- ───────────── Прогресс воронки per-(event, contact) ─────────────
-- Одна запись на конкретного человека в конкретном событии. Создаётся при первом
-- открытии события (если не зарегистрирован). Удаляется при регистрации /
-- старте события / истечении всех шагов.
CREATE TABLE IF NOT EXISTS event_nurture_runs (
    id              BIGSERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    contact_id      BIGINT  NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_step_index INTEGER NOT NULL DEFAULT -1,  -- индекс последнего отправленного шага (по sort_order)
    last_step_at    TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,                  -- если все шаги отправлены или регистрация/отмена
    finished_reason TEXT,                          -- 'registered' | 'event_started' | 'all_sent' | 'cancelled'
    UNIQUE (event_id, contact_id)
);
CREATE INDEX IF NOT EXISTS event_nurture_runs_pending_idx
    ON event_nurture_runs (started_at) WHERE finished_at IS NULL;

COMMENT ON TABLE event_nurture_steps IS 'Шаги воронки догрева на событие (per-event настройка клиентом)';
COMMENT ON TABLE event_nurture_runs  IS 'Прогресс прохождения воронки догрева конкретным контактом';
