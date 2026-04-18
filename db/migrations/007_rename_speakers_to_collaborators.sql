-- Migration 007: rename speakers → collaborators
-- Коллаборации — уровень выше конференции (per-client CRM).
-- Используются в конференциях, премиях, турнирах через роли в junction-таблицах.

ALTER TABLE speakers RENAME TO collaborators;

-- Переименовываем sequence (создаётся автоматически для SERIAL/BIGSERIAL)
ALTER SEQUENCE IF EXISTS speakers_id_seq RENAME TO collaborators_id_seq;
