-- Миграция 010: добавить topic_id в conf_sessions
-- Слот программы теперь может ссылаться на конкретную тему из карточки спикера

ALTER TABLE conf_sessions
  ADD COLUMN IF NOT EXISTS topic_id INTEGER
    REFERENCES conf_speaker_topics(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conf_sessions_topic ON conf_sessions(topic_id);
