-- ═══════════════════════════════════════════
-- Миграция 023: поля реферера в platform_users
-- referrer_tg_id и referrer_ref_code — кто привёл этот контакт
-- ═══════════════════════════════════════════

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS referrer_tg_id    TEXT,
  ADD COLUMN IF NOT EXISTS referrer_ref_code VARCHAR(100);
