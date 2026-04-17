-- ═══════════════════════════════════════════════════════════════════
-- Миграция 004: Дочистка после рефакторинга спикеров
-- Переключаем FK с conf_speakers → conf_speaker_events, удаляем conf_speakers
-- ═══════════════════════════════════════════════════════════════════

-- conf_sessions: speaker_id → conf_speaker_events.id
ALTER TABLE conf_sessions DROP CONSTRAINT IF EXISTS conf_sessions_speaker_id_fkey;
ALTER TABLE conf_sessions
    ADD CONSTRAINT conf_sessions_speaker_event_fkey
    FOREIGN KEY (speaker_id) REFERENCES conf_speaker_events(id) ON DELETE SET NULL;

-- conf_secret_codes: speaker_id → conf_speaker_events.id
ALTER TABLE conf_secret_codes DROP CONSTRAINT IF EXISTS conf_secret_codes_speaker_id_fkey;
ALTER TABLE conf_secret_codes
    ADD CONSTRAINT conf_secret_codes_speaker_event_fkey
    FOREIGN KEY (speaker_id) REFERENCES conf_speaker_events(id) ON DELETE SET NULL;

-- conf_broadcast_messages: speaker_id → conf_speaker_events.id
ALTER TABLE conf_broadcast_messages DROP CONSTRAINT IF EXISTS conf_broadcast_messages_speaker_id_fkey;
ALTER TABLE conf_broadcast_messages
    ADD CONSTRAINT conf_broadcast_messages_speaker_event_fkey
    FOREIGN KEY (speaker_id) REFERENCES conf_speaker_events(id) ON DELETE SET NULL;

-- Удаляем старую таблицу
DROP TABLE IF EXISTS conf_speakers;
