-- ═══════════════════════════════════════════
-- Миграция 021: добавляем поля для импорта из Salebot
-- email, phone, tags, utm_source, last_contact_at, ref_code
-- ═══════════════════════════════════════════

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS email          TEXT,
  ADD COLUMN IF NOT EXISTS phone          TEXT,
  ADD COLUMN IF NOT EXISTS tags           JSONB,
  ADD COLUMN IF NOT EXISTS utm_source     TEXT,
  ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ref_code       TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_platform_users_ref_code ON platform_users(ref_code) WHERE ref_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_users_email ON platform_users(email) WHERE email IS NOT NULL;
