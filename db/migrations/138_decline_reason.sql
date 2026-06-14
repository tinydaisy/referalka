-- 138_decline_reason.sql
-- Причина отклонения запроса на коллаборацию (опциональна).
ALTER TABLE hub_collab_requests ADD COLUMN IF NOT EXISTS decline_reason TEXT;
