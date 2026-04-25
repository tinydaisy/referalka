-- ═══════════════════════════════════════════
-- Миграция 032: один реф-код на человека, живёт ТОЛЬКО в platform_users.ref_code
--
-- Принцип:
--   - platform_users.ref_code — единственный источник реф-кода человека
--   - event_participants и conf_speaker_events используют его через JOIN на platform_users
--   - collaborators получает явную FK-связь с platform_users (вместо резолва по personal_tg_id)
--
-- Перед миграцией данные уже синхронизированы вручную:
--   - все pu.ref_code = ep.ref_code (0 расхождений)
--   - все cse.ref_code = pu.ref_code соответствующего коллаборатора (0 расхождений)
--   - все 54 collaborators имеют контакт в platform_users
-- ═══════════════════════════════════════════

BEGIN;

-- ── platform_users ──────────────────────────
-- Переименовать referrer_ref_code → first_referrer_ref_code (точнее имя: «кто ВПЕРВЫЕ привёл контакт»)
ALTER TABLE platform_users RENAME COLUMN referrer_ref_code TO first_referrer_ref_code;

-- Удалить referrer_tg_id (привязка к платформе несовместима с мультиплатформой)
ALTER TABLE platform_users DROP COLUMN IF EXISTS referrer_tg_id;

-- ── collaborators → platform_users ──────────
-- Явная связь коллаба с контактом (вместо резолва по совпадению personal_tg_id)
ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS platform_user_id INTEGER REFERENCES platform_users(id) ON DELETE SET NULL;

-- Заполнить из текущих данных (по совпадению personal_tg_id или org_X)
UPDATE collaborators c
SET platform_user_id = pu.id
FROM platform_users pu
WHERE pu.client_id = c.created_by_client_id
  AND pu.platform_user_id = c.personal_tg_id
  AND c.personal_tg_id IS NOT NULL
  AND c.platform_user_id IS NULL;

UPDATE collaborators c
SET platform_user_id = pu.id
FROM platform_users pu
WHERE pu.client_id = c.created_by_client_id
  AND pu.platform_user_id = 'org_' || c.id::text
  AND c.platform_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_collaborators_platform_user ON collaborators(platform_user_id);

-- ── event_participants ──────────────────────
-- Удалить ref_code (берём через JOIN platform_users)
ALTER TABLE event_participants DROP CONSTRAINT IF EXISTS event_participants_ref_code_key;
DROP INDEX IF EXISTS idx_event_participants_refcode;
ALTER TABLE event_participants DROP COLUMN IF EXISTS ref_code;

-- ── conf_speaker_events ─────────────────────
-- Удалить ref_code (берём через JOIN collaborators → platform_users)
ALTER TABLE conf_speaker_events DROP CONSTRAINT IF EXISTS conf_speaker_events_ref_code_key;
ALTER TABLE conf_speaker_events DROP COLUMN IF EXISTS ref_code;

COMMIT;
