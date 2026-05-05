-- ═══════════════════════════════════════════════════════════════════
-- Миграция 065: разделение 5min_before на конф (per-session) и event_live (для мероприятий)
--
-- Раньше тип `5min_before` использовался и в конференциях, и в мероприятиях,
-- но семантика разная:
--   • В конференции — за 5 мин до выступления спикера (per-session, hasSpeaker)
--   • В мероприятии — за 5 мин до старта мероприятия (event-level, без спикера)
--
-- Для ясности вводим отдельный тип `event_live` для мероприятий.
-- Для всех существующих не-конференций конвертируем 5min_before → event_live
-- (в broadcast_templates, broadcast_schedules, broadcast_log).
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- 1) Шаблоны мероприятий: 5min_before → event_live
UPDATE broadcast_templates bt
   SET type = 'event_live',
       name = 'За 5 минут до старта мероприятия'
  FROM events e
 WHERE bt.event_id = e.id
   AND bt.type    = '5min_before'
   AND e.module_slug <> 'conference';

-- 2) Расписание: те же записи в очереди
UPDATE broadcast_schedules bs
   SET type = 'event_live'
  FROM events e
 WHERE bs.event_id = e.id
   AND bs.type     = '5min_before'
   AND e.module_slug <> 'conference';

-- 3) Лог отправок (если столбец type есть)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'broadcast_log' AND column_name = 'type'
    ) THEN
        EXECUTE $sql$
            UPDATE broadcast_log bl
               SET type = 'event_live'
              FROM events e
             WHERE bl.event_id = e.id
               AND bl.type     = '5min_before'
               AND e.module_slug <> 'conference'
        $sql$;
    END IF;
END $$;

COMMIT;
