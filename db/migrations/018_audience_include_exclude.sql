-- Миграция 018: заменяем audience_type на audience_include + audience_exclude
-- Логика: итоговая аудитория = audience_include − audience_exclude

-- Шаблоны: добавляем новые колонки
ALTER TABLE broadcast_templates
    ADD COLUMN IF NOT EXISTS audience_include TEXT NOT NULL DEFAULT 'all_event',
    ADD COLUMN IF NOT EXISTS audience_exclude TEXT NOT NULL DEFAULT 'none';

-- Переносим старые значения
UPDATE broadcast_templates SET
    audience_include = audience_type,
    audience_exclude = 'none'
WHERE audience_include = 'all_event';

-- Зарегистрированные: include=all_event, exclude=none (исходно registered_event)
-- Исправляем: registered_event → include=all_event, exclude=unregistered_event
UPDATE broadcast_templates SET
    audience_include = 'all_event',
    audience_exclude = 'unregistered_event'
WHERE audience_type = 'registered_event';

-- all_client оставляем как есть (exclude=none)

-- Шаблон day_start_30min_unreg: все кроме зарег = all_event − registered_event
UPDATE broadcast_templates SET
    audience_include = 'all_event',
    audience_exclude = 'registered_event'
WHERE type = 'day_start_30min_unreg';

-- Шаблон day_start_30min_reg: только зарег = all_event − unregistered_event
UPDATE broadcast_templates SET
    audience_include = 'all_event',
    audience_exclude = 'unregistered_event'
WHERE type = 'day_start_30min_reg';

-- Расписание: аналогично
ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS audience_include TEXT NOT NULL DEFAULT 'all_event',
    ADD COLUMN IF NOT EXISTS audience_exclude TEXT NOT NULL DEFAULT 'none';

UPDATE broadcast_schedules SET
    audience_include = COALESCE(audience_type, 'all_event'),
    audience_exclude = 'none';

UPDATE broadcast_schedules SET
    audience_include = 'all_event',
    audience_exclude = 'registered_event'
WHERE audience_type = 'all_event'
  AND template_id IN (SELECT id FROM broadcast_templates WHERE type = 'day_start_30min_unreg');

UPDATE broadcast_schedules SET
    audience_include = 'all_event',
    audience_exclude = 'unregistered_event'
WHERE audience_type IN ('registered_event')
   OR template_id IN (SELECT id FROM broadcast_templates WHERE type = 'day_start_30min_reg');

-- Индекс
CREATE INDEX IF NOT EXISTS idx_broadcast_schedules_audience
    ON broadcast_schedules (event_id, audience_include, audience_exclude);
