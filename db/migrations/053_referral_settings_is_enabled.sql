-- 053_referral_settings_is_enabled.sql
-- Добавляем флаг is_enabled в event_referral_settings —
-- симметрично event_raffle_settings.is_enabled.
--
-- Когда is_enabled = TRUE → в Mini App у события показывается вкладка «🎯 Игра».
-- Когда FALSE (дефолт) → вкладка скрыта.
-- Старые события без записи в event_referral_settings считаются «выключенными»
-- (что соответствует дефолту).
--
-- Применить: psql -d plusson -f db/migrations/053_referral_settings_is_enabled.sql

ALTER TABLE event_referral_settings
  ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT FALSE;
