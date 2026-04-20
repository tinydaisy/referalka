-- Migration 014: флаг "бот добавлен в канал спикера" для конкретной конференции.
-- Используется для публичного API проверки подписки участника на каналы спикеров.
-- Неразрушающая операция: добавляем колонку с дефолтом FALSE, существующие строки получают FALSE.

ALTER TABLE conf_speaker_events
  ADD COLUMN IF NOT EXISTS bot_in_channel BOOLEAN DEFAULT FALSE;
