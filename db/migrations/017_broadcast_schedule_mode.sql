-- Расширение шаблонов рассылок: режим расписания и аудитория
-- schedule_mode:
--   'fixed_offset'    — pre_start, gift: отправить за N минут до/после сессии (offset_minutes)
--   'day_offset'      — day_start_30min_*, day_live, day_end: отправить в определённое время дня (offset_minutes от начала/конца дня)
--   'custom_datetime' — speaker_intro: пользователь задаёт дату+время вручную
-- audience_type:
--   'all_event'        — все участники конкретного события (event_participants)
--   'registered_event' — только зарегистрированные участники события
--   'all_client'       — вся база клиента (platform_users по client_id)
-- allow_custom_datetime: если true — в очереди показываем поле выбора даты/времени

ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS schedule_mode       TEXT    NOT NULL DEFAULT 'fixed_offset',
  ADD COLUMN IF NOT EXISTS offset_minutes      INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS audience_type       TEXT    NOT NULL DEFAULT 'all_event',
  ADD COLUMN IF NOT EXISTS allow_custom_datetime BOOLEAN NOT NULL DEFAULT FALSE;

-- Проставляем корректные defaults для уже существующих шаблонов
UPDATE broadcast_templates SET schedule_mode = 'fixed_offset',   offset_minutes = 5,  audience_type = 'all_event'        WHERE type = 'pre_start';
UPDATE broadcast_templates SET schedule_mode = 'fixed_offset',   offset_minutes = 10, audience_type = 'all_event'        WHERE type = 'gift';
UPDATE broadcast_templates SET schedule_mode = 'custom_datetime', offset_minutes = 0,  audience_type = 'all_event', allow_custom_datetime = TRUE WHERE type = 'speaker_intro';
UPDATE broadcast_templates SET schedule_mode = 'day_offset',     offset_minutes = 30, audience_type = 'all_event'        WHERE type = 'day_start_30min_unreg';
UPDATE broadcast_templates SET schedule_mode = 'day_offset',     offset_minutes = 30, audience_type = 'registered_event' WHERE type = 'day_start_30min_reg';
UPDATE broadcast_templates SET schedule_mode = 'day_offset',     offset_minutes = 0,  audience_type = 'all_event'        WHERE type = 'day_live';
UPDATE broadcast_templates SET schedule_mode = 'day_offset',     offset_minutes = 30, audience_type = 'all_event'        WHERE type = 'day_end';

-- audience_type и is_test в broadcast_schedules
ALTER TABLE broadcast_schedules
  ADD COLUMN IF NOT EXISTS audience_type TEXT NOT NULL DEFAULT 'all_event';

-- Индексы для быстрого старта очереди
CREATE INDEX IF NOT EXISTS idx_broadcast_schedules_launch ON broadcast_schedules (event_id, status, fire_at);
