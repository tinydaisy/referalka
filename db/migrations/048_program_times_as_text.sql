-- 048_program_times_as_text.sql
-- 28.04.2026
--
-- Цель: убрать всю математику часовых поясов из времени программы.
-- Время сессий и расписания дней храним строками "HH:MM" (МСК — везде по соглашению).
--
-- conf_days.open_time   TIME → TEXT  ("10:00")
-- conf_days.close_time  TIME → TEXT  ("18:00")
-- conf_sessions.start_datetime TIMESTAMPTZ → start_time TEXT ("11:30"), привязка к дню через s.day
-- conf_sessions.end_datetime   TIMESTAMPTZ → end_time   TEXT ("12:00")
--
-- ВАЖНО: конвертацию делаем через 'Europe/Moscow' — то время, что клиент видел, тем и останется.

BEGIN;

------------------------------------------------------------
-- conf_days: TIME → TEXT
------------------------------------------------------------

ALTER TABLE conf_days
  ALTER COLUMN open_time TYPE text
    USING CASE WHEN open_time IS NULL THEN NULL ELSE to_char(open_time, 'HH24:MI') END;

ALTER TABLE conf_days
  ALTER COLUMN close_time TYPE text
    USING CASE WHEN close_time IS NULL THEN NULL ELSE to_char(close_time, 'HH24:MI') END;

------------------------------------------------------------
-- conf_sessions: timestamptz → текстовые HH:MM
------------------------------------------------------------

-- Добавляем новые текстовые колонки
ALTER TABLE conf_sessions
  ADD COLUMN IF NOT EXISTS start_time text,
  ADD COLUMN IF NOT EXISTS end_time   text;

-- Переносим значения. Время в БД хранится как UTC; на дисплее показывалось в МСК.
-- Поэтому конвертируем UTC → 'Europe/Moscow' и берём HH:MM.
UPDATE conf_sessions
SET start_time = CASE
        WHEN start_datetime IS NULL THEN NULL
        ELSE to_char(start_datetime AT TIME ZONE 'Europe/Moscow', 'HH24:MI')
    END,
    end_time = CASE
        WHEN end_datetime IS NULL THEN NULL
        ELSE to_char(end_datetime AT TIME ZONE 'Europe/Moscow', 'HH24:MI')
    END;

-- Удаляем устаревшие timestamptz-колонки и индексы по ним
DROP INDEX IF EXISTS idx_conf_sessions_day;

ALTER TABLE conf_sessions
  DROP COLUMN start_datetime,
  DROP COLUMN end_datetime;

-- Возвращаем индекс по (event_id, day) — без datetime в сортировке
CREATE INDEX IF NOT EXISTS idx_conf_sessions_day
  ON conf_sessions (event_id, day);

COMMIT;
