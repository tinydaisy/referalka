-- 056_raffle_tickets_winners_and_live_at.sql
-- MVP-модель розыгрыша (зафиксирована 2026-05-01).
--
-- Что добавляем:
-- 1. event_participants.live_at — отметка времени последнего входа по
--    публичной live-ссылке. «В эфире сейчас» = live_at > now() - 120 min.
--    Ставится из POST /api/v1/events/{slug}/live (Mini App).
-- 2. event_raffle_tickets — глобальный пул билетов per-event. code_word
--    хранит ТЕКСТ (само слово или литерал 'Free' для стартового билета).
--    UNIQUE(event_id, contact_id, code_word) — один человек одно слово
--    вводит максимум один раз. Номер билета на UI = id с pad до 5 цифр.
-- 3. event_raffle_winners — победители. UNIQUE(ticket_id) — один билет
--    может выиграть только один раз. На speaker_event_id UNIQUE НЕ ставим,
--    чтобы можно было «переразыграть» (DELETE → POST).
--
-- Применить: psql -d plusson -f db/migrations/056_raffle_tickets_winners_and_live_at.sql

ALTER TABLE event_participants
  ADD COLUMN IF NOT EXISTS live_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_event_participants_live_at
  ON event_participants(event_id, live_at)
  WHERE live_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_raffle_tickets (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id  INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  code_word   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, contact_id, code_word)
);
CREATE INDEX IF NOT EXISTS idx_raffle_tickets_event
  ON event_raffle_tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_raffle_tickets_event_contact
  ON event_raffle_tickets(event_id, contact_id);

CREATE TABLE IF NOT EXISTS event_raffle_winners (
  id                SERIAL PRIMARY KEY,
  speaker_event_id  INT NOT NULL REFERENCES conf_speaker_events(id) ON DELETE CASCADE,
  ticket_id         INT NOT NULL UNIQUE REFERENCES event_raffle_tickets(id) ON DELETE CASCADE,
  won_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_raffle_winners_speaker
  ON event_raffle_winners(speaker_event_id);
