-- Миграция 093: этапы и залы программы конференции/турнира
--
-- 1. conf_stages — этапы (необязательный уровень над днями).
--    Пример: «Предстарт» (2 недели, 15–25 июня) + «Основной этап» (с программой по дням).
--    Если у конференции нет ни одного этапа — структура остаётся плоской «дни → сессии», как сейчас.
--
-- 2. conf_days.stage_id — опциональная привязка дня к этапу.
--    NULL = «свободный» день, не входящий ни в какой этап (обратная совместимость).
--
-- 3. conf_days.title — кастомное имя дня («Дата 1», «Открытие», «Финальный день»).
--    Если NULL — фронт показывает «День N» по day_number, как раньше.
--
-- 4. conf_tracks — залы события (параллельные потоки).
--    Заводим таблицу на уровне БД, но в UI пока не используем. Сессии с NULL track_id
--    = «один общий зал», как сейчас. Старые поля conf_sessions.track_label/track_color/stream_url
--    оставляем как deprecated — мигрируем данные туда же, когда реально откроем залы в UI.
--
-- 5. conf_sessions.track_id — опциональная привязка сессии к залу. NULL = общий зал.

BEGIN;

-- 1. Этапы
CREATE TABLE IF NOT EXISTS conf_stages (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sort_order  INT NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  subtitle    TEXT,
  description TEXT,
  start_date  DATE,
  end_date    DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conf_stages_event ON conf_stages(event_id);
CREATE INDEX IF NOT EXISTS idx_conf_stages_order ON conf_stages(event_id, sort_order);

-- 2-3. День → этап + кастомное имя дня
ALTER TABLE conf_days
  ADD COLUMN IF NOT EXISTS stage_id INT REFERENCES conf_stages(id) ON DELETE SET NULL;
ALTER TABLE conf_days
  ADD COLUMN IF NOT EXISTS title TEXT;
CREATE INDEX IF NOT EXISTS idx_conf_days_stage ON conf_days(stage_id);

-- 4. Залы (на будущее, UI не используется)
CREATE TABLE IF NOT EXISTS conf_tracks (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sort_order  INT NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  color       TEXT,
  stream_url  TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conf_tracks_event ON conf_tracks(event_id);
CREATE INDEX IF NOT EXISTS idx_conf_tracks_order ON conf_tracks(event_id, sort_order);

-- 5. Сессия → зал
ALTER TABLE conf_sessions
  ADD COLUMN IF NOT EXISTS track_id INT REFERENCES conf_tracks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conf_sessions_track ON conf_sessions(track_id);

COMMIT;
