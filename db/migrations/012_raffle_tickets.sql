-- Билеты розыгрыша конференции
CREATE TABLE IF NOT EXISTS conf_raffle_tickets (
  id                SERIAL PRIMARY KEY,
  event_id          INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_number     INT NOT NULL,
  tg_username       TEXT,
  tg_id             BIGINT,
  tg_name           TEXT,
  salebot_client_id TEXT,
  pluson_participant_id INT REFERENCES event_participants(id) ON DELETE SET NULL,
  code_word         TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_raffle_tickets_event ON conf_raffle_tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_raffle_tickets_tg_id ON conf_raffle_tickets(tg_id);
