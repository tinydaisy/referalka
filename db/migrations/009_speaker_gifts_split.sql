-- Миграция 009: разделить подарки спикера на два типа
-- gift_after_speech (подарок после выступления) и gift_raffle (подарок для розыгрыша)
-- Текущие gift_title / gift_url переименовываем в gift_after_speech_title / gift_after_speech_url

ALTER TABLE conf_speaker_events
  RENAME COLUMN gift_title TO gift_after_speech_title;

ALTER TABLE conf_speaker_events
  RENAME COLUMN gift_url TO gift_after_speech_url;

ALTER TABLE conf_speaker_events
  ADD COLUMN IF NOT EXISTS gift_raffle_title TEXT,
  ADD COLUMN IF NOT EXISTS gift_raffle_url   TEXT;
