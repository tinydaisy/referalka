-- 164: session_id в broadcast_schedules — полиморфный, снимаем FK на conf_sessions.
--
-- Поле broadcast_schedules.session_id используется для РАЗНЫХ сущностей:
--   • 5min_before / gift  → conf_sessions.id (сессия программы)
--   • speaker_intro       → event_collaborators.id (коллаборатор)
-- FK на conf_sessions ломал генерацию speaker_intro для турниров, где id
-- коллаба не совпадает ни с одной conf_session → ForeignKeyViolationError.
-- На конференциях FK «случайно» проходил, потому что мелкие id коллабов
-- совпадали с существующими conf_sessions.

ALTER TABLE broadcast_schedules
  DROP CONSTRAINT IF EXISTS broadcast_schedules_session_id_fkey;
