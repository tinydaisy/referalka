-- 123_event_collaborators_show_partner_link.sql
-- 2026-05-29
--
-- Тогл «показывать ли ссылку на регистрацию партнёром» на странице
-- самообслуживания спикера (/speaker/<event_slug>). По умолчанию TRUE
-- (показываем) — клиент может выключить для тех, кому не нужно
-- агитировать в партнёрку (например, жюри уже партнёр, или у него
-- закрытая позиция). При саморегистрации спикером через бот ставится
-- FALSE — самозаписавшимся партнёрская воронка не предлагается до
-- явной активации клиентом.

BEGIN;

ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS show_partner_registration_link BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
