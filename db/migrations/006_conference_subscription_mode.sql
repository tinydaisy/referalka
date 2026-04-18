-- Миграция 006: режим подписки и организатор конференции
ALTER TABLE conf_conferences
  ADD COLUMN IF NOT EXISTS subscription_mode TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS organizer_speaker_id INTEGER REFERENCES speakers(id) ON DELETE SET NULL;
-- subscription_mode: 'none' | 'organizer' | 'all_speakers'
