-- 313: Автовебинар — запись проигрывается по расписанию как живой эфир.
--
-- Зачем: клиент проводит один хороший эфир и дальше «крутит» его новым зрителям
-- без своего участия. Уход с GetCourse — там это ключевая механика.
--
-- ⚠️ Отдельной таблицы «автовебинар» НЕТ: это та же webinar_rooms со
-- stream_type='auto'. Всё остальное (чат, продающие блоки с таймингом,
-- опросы, реакции, аналитика) переиспользуется как есть — иначе пришлось бы
-- чинить вёрстку и логику в двух местах.

ALTER TABLE webinar_rooms
  -- какую запись крутим (ON DELETE SET NULL: удалили запись — комната не ломается)
  ADD COLUMN IF NOT EXISTS auto_recording_id INT
      REFERENCES webinar_recordings(id) ON DELETE SET NULL,
  -- 'schedule' — по расписанию (все видят одно и то же, как живой эфир),
  -- 'on_signup' — старт через N минут после регистрации зрителя (у каждого свой)
  ADD COLUMN IF NOT EXISTS auto_mode TEXT NOT NULL DEFAULT 'schedule',
  ADD COLUMN IF NOT EXISTS auto_delay_min INT NOT NULL DEFAULT 15,
  -- ⚠️ Перемотку вперёд запрещаем по умолчанию: смысл автовебинара в том, что
  -- продающие блоки выстреливают по таймингу, а перемотка их обесценивает.
  ADD COLUMN IF NOT EXISTS auto_allow_seek BOOLEAN NOT NULL DEFAULT FALSE;

-- Расписание запусков: «каждый день в 19:00», «по будням», «разово 5 марта».
CREATE TABLE IF NOT EXISTS webinar_auto_schedule (
  id          SERIAL PRIMARY KEY,
  room_id     INT NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
  -- 'daily' | 'weekly' | 'once'
  kind        TEXT NOT NULL DEFAULT 'daily',
  -- дни недели для weekly: 1=пн … 7=вс
  weekdays    INT[] NOT NULL DEFAULT '{}',
  -- ⚠️ Время строкой "HH:MM" и всегда МСК — как в программе конференции
  -- (conf_sessions.start_time). Иначе сдвиги часовых поясов в Mini App и вебе.
  at_time     TEXT NOT NULL,
  once_date   DATE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wauto_sched_room ON webinar_auto_schedule(room_id);

-- Сценарий чата: заранее написанные реплики, всплывающие по таймингу записи.
CREATE TABLE IF NOT EXISTS webinar_auto_chat (
  id          SERIAL PRIMARY KEY,
  room_id     INT NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
  -- секунда записи, на которой появляется реплика
  at_sec      INT NOT NULL DEFAULT 0,
  author_name TEXT NOT NULL,
  text        TEXT NOT NULL,
  -- реплика ведущего выделяется в чате
  is_host     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wauto_chat_room ON webinar_auto_chat(room_id, at_sec);

-- Персональный запуск зрителя (для auto_mode='on_signup'): у каждого свой старт.
CREATE TABLE IF NOT EXISTS webinar_auto_runs (
  id          SERIAL PRIMARY KEY,
  room_id     INT NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
  contact_id  INT REFERENCES contacts(id) ON DELETE SET NULL,
  session_key TEXT,
  starts_at   TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wauto_runs_room ON webinar_auto_runs(room_id, contact_id);

-- ⚠️ Роль plusson НЕ владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  webinar_auto_schedule, webinar_auto_chat, webinar_auto_runs TO plusson;
GRANT USAGE, SELECT ON
  webinar_auto_schedule_id_seq, webinar_auto_chat_id_seq, webinar_auto_runs_id_seq TO plusson;
