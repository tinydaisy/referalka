-- 224. Вебинар: эфирные сессии (запуски), записи, привязка аналитики к запуску.
--
-- ЗАЧЕМ. Один день можно запускать в эфир НЕСКОЛЬКО раз (тест + боевой прогон).
-- Раньше presence/activity писались «на комнату» → тест смешивался с боевой
-- статистикой. Теперь каждый «Начать эфир → Завершить эфир» = отдельная СЕССИЯ
-- (webinar_sessions) со своим временем, своей аналитикой и своей записью.
--
-- Записи эфира заливаются в R2 (как афиши/видео), в БД — webinar_recordings.
-- Обзор батлов события — по всем дням (webinar_battles уже есть, тут только связи).

BEGIN;

-- ── Сессия = один запуск эфира ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_sessions (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ,                         -- NULL = сессия идёт
    title       TEXT,                                -- опц. подпись запуска
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_sessions_room ON webinar_sessions(room_id, started_at);

-- текущая активная сессия комнаты (для быстрой записи presence/activity)
ALTER TABLE webinar_rooms
  ADD COLUMN IF NOT EXISTS current_session_id INTEGER REFERENCES webinar_sessions(id) ON DELETE SET NULL;

-- ── Привязка присутствия/активности к запуску ────────────────────────────────
-- session_id NULL = старые данные «по дню» (совместимость). Новые пишут запуск.
ALTER TABLE webinar_presence
  ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES webinar_sessions(id) ON DELETE CASCADE;
ALTER TABLE webinar_activity
  ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES webinar_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_webinar_presence_session ON webinar_presence(session_id);
CREATE INDEX IF NOT EXISTS idx_webinar_activity_session ON webinar_activity(session_id);

-- ── Записи эфира (файлы в R2) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_recordings (
    id              SERIAL PRIMARY KEY,
    room_id         INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    session_id      INTEGER REFERENCES webinar_sessions(id) ON DELETE SET NULL,
    url             TEXT,                             -- R2 URL готовой записи
    r2_key          TEXT,                             -- ключ в R2 (для удаления)
    status          TEXT NOT NULL DEFAULT 'processing', -- processing | ready | failed
    duration_sec    INTEGER,
    size_bytes      BIGINT,
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_recordings_room ON webinar_recordings(room_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_sessions, webinar_recordings TO plusson;
GRANT USAGE, SELECT ON SEQUENCE webinar_sessions_id_seq, webinar_recordings_id_seq TO plusson;

COMMIT;
