-- 075_rename_conf_speaker_events.sql (07.05.2026)
-- Переименовываем conf_speaker_events → event_collaborators.
-- Семантически таблица давно вышла за рамки конференции: уже хранит роли
-- 'speaker' / 'organizer' / 'headliner' / 'partner'. Теперь будет использоваться
-- и для мероприятий (роль 'organizer' = соорганизатор).
--
-- FK constraints в таблицах conf_broadcast_messages, conf_secret_codes,
-- conf_sessions, conf_speaker_topics, event_raffle_winners продолжают работать
-- автоматически (PostgreSQL отслеживает ссылки по OID, не по имени).
-- Имена FK-констрейнтов «conf_speaker_events_*_fkey» остаются — это исторический
-- мусор, не функциональный.

BEGIN;

ALTER TABLE conf_speaker_events RENAME TO event_collaborators;

-- Переименовываем индексы и UNIQUE-констрейнты для консистентности
ALTER INDEX conf_speaker_events_pkey
  RENAME TO event_collaborators_pkey;
ALTER INDEX conf_speaker_events_speaker_id_event_id_key
  RENAME TO event_collaborators_speaker_event_key;
ALTER INDEX idx_conf_speaker_events_event
  RENAME TO idx_event_collaborators_event;
ALTER INDEX idx_conf_speaker_events_speaker
  RENAME TO idx_event_collaborators_speaker;

-- Sequence тоже переименуем для опрятности
ALTER SEQUENCE conf_speaker_events_id_seq RENAME TO event_collaborators_id_seq;

COMMIT;
