-- Миграция 129 (2026-06-09) — Воронка догрева для ЗАРЕГИСТРИРОВАННЫХ участников.
--
-- Зеркало воронки event_nurture (миграция 088), но для другой аудитории:
-- человек уже зарегистрировался на событие. Серия сообщений помогает ему
-- «не потеряться»: вступить в чаты события, закрепить бота, и т.п.
--
-- Триггер запуска: finalize_participant_registration (единая точка регистрации,
-- см. services/participant_registration.py) при первой регистрации участника.
-- Останов: когда событие завершилось (end_at прошёл / status='ended').
--
-- Отличие от event_nurture (незарег.):
--   • event_nurture        — стартует при ОТКРЫТИИ события без регистрации;
--   • event_nurture_reg    — стартует при РЕГИСТРАЦИИ участника.
-- Это две независимые воронки, у каждой свои шаги и свои runs.

-- ───────────── Шаги воронки для зарегистрированных (per-event) ─────────────
CREATE TABLE IF NOT EXISTS event_nurture_reg_steps (
    id              BIGSERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    offset_seconds  INTEGER NOT NULL,             -- через сколько секунд после регистрации
    text            TEXT    NOT NULL DEFAULT '',  -- HTML (<b>, <i>, <a>)
    button_label    TEXT    NOT NULL DEFAULT '',  -- пусто = без кнопки
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (offset_seconds >= 0)
);
CREATE INDEX IF NOT EXISTS event_nurture_reg_steps_event_idx
    ON event_nurture_reg_steps (event_id, sort_order);

-- ───────────── Прогресс воронки per-(event, contact) ─────────────
CREATE TABLE IF NOT EXISTS event_nurture_reg_runs (
    id              BIGSERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    contact_id      BIGINT  NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_step_index INTEGER NOT NULL DEFAULT -1,  -- индекс последнего отправленного шага
    last_step_at    TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    finished_reason TEXT,                          -- 'event_ended' | 'all_sent' | 'no_channel'
    UNIQUE (event_id, contact_id)
);
CREATE INDEX IF NOT EXISTS event_nurture_reg_runs_pending_idx
    ON event_nurture_reg_runs (started_at) WHERE finished_at IS NULL;

COMMENT ON TABLE event_nurture_reg_steps IS 'Шаги воронки догрева ЗАРЕГИСТРИРОВАННЫХ участников (per-event)';
COMMENT ON TABLE event_nurture_reg_runs  IS 'Прогресс воронки догрева зарегистрированных конкретным контактом';

-- ───────────── button_kind: куда ведёт кнопка шага ─────────────
-- Для обеих воронок (незарег. event_nurture_steps + зарег. event_nurture_reg_steps).
--   'event'   — на страницу события в Mini App (default, прежнее поведение);
--   'support' — на t.me/{work_tg_username}?text=… (служба поддержки клиента).
-- Незарег. Шаг 1 «не получилось зарегистрироваться» использует 'support'.
ALTER TABLE event_nurture_steps
    ADD COLUMN IF NOT EXISTS button_kind TEXT NOT NULL DEFAULT 'event'
    CHECK (button_kind IN ('event', 'support'));
ALTER TABLE event_nurture_reg_steps
    ADD COLUMN IF NOT EXISTS button_kind TEXT NOT NULL DEFAULT 'event'
    CHECK (button_kind IN ('event', 'support'));

-- GRANT-ы для роли plusson (на dev/проде роль БД не postgres)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plusson') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON event_nurture_reg_steps, event_nurture_reg_runs TO plusson';
        EXECUTE 'GRANT USAGE, SELECT ON event_nurture_reg_steps_id_seq, event_nurture_reg_runs_id_seq TO plusson';
    END IF;
END $$;
