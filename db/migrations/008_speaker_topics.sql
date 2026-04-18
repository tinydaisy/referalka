-- Миграция 008: массив тем выступления для спикера в событии
-- Вместо одного поля speaker_topic в conf_speaker_events
-- создаём отдельную таблицу для нескольких тем

CREATE TABLE IF NOT EXISTS conf_speaker_topics (
    id          SERIAL PRIMARY KEY,
    cse_id      INTEGER NOT NULL REFERENCES conf_speaker_events(id) ON DELETE CASCADE,
    topic       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conf_speaker_topics_cse_id ON conf_speaker_topics(cse_id);

-- Переносим существующие одиночные темы в новую таблицу
INSERT INTO conf_speaker_topics (cse_id, topic, sort_order)
SELECT id, speaker_topic, 0
FROM conf_speaker_events
WHERE speaker_topic IS NOT NULL AND speaker_topic <> '';

-- Поле speaker_topic оставляем для обратной совместимости (пока),
-- но новый код будет использовать только conf_speaker_topics
