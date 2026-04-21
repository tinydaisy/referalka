-- Миграция 022: таблица отчётов конференции
-- Отчёт = снимок статистики по участникам на конкретный момент времени
-- Спикеры = collaborators из conf_speaker_events
-- Рефералы = остальные участники event_participants

CREATE TABLE IF NOT EXISTS conf_reports (
    id              SERIAL PRIMARY KEY,
    event_id        INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    announcements   INT NOT NULL DEFAULT 0,    -- кол-во сделанных анонсов (вводится вручную)

    -- Сводка
    total_entered   INT NOT NULL DEFAULT 0,    -- всего зашло в бот
    total_registered INT NOT NULL DEFAULT 0,  -- всего зарегистрировалось
    speakers_entered INT NOT NULL DEFAULT 0,  -- от спикеров: зашло
    speakers_registered INT NOT NULL DEFAULT 0, -- от спикеров: зарег.
    referrals_entered INT NOT NULL DEFAULT 0, -- от рефералов: зашло
    referrals_registered INT NOT NULL DEFAULT 0, -- от рефералов: зарег.

    -- Детализация по спикерам и рефералам (JSON-снимок)
    speakers_data   JSONB NOT NULL DEFAULT '[]',  -- [{speaker_event_id, name, tg_id, entered, registered}]
    referrals_data  JSONB NOT NULL DEFAULT '[]'   -- [{platform_user_id, name, username, tg_id, entered, registered}]
);

CREATE INDEX IF NOT EXISTS idx_conf_reports_event ON conf_reports(event_id);
CREATE INDEX IF NOT EXISTS idx_conf_reports_created ON conf_reports(event_id, created_at DESC);
