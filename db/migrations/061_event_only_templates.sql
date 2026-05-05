-- Миграция 061 (05.05.2026): добавить недостающие шаблоны мероприятиям + универсальные тексты
--
-- ПРОБЛЕМА: у существующих мероприятий из миграции 060 заинсёрчены только
-- 30min_before и day_before_09_12_*. Не хватает 5min_before, 2h_before_unreg,
-- 2h_before_reg. Auto-seed их не добавит — он срабатывает только при пустых
-- rows, а у мероприятий уже есть 3 шаблона.
--
-- ТАКЖЕ: 5min_before в DEFAULT_TEMPLATES имеет текст со {speaker_name}/{speaker_topic} —
-- для мероприятий (без спикеров) это бессмыслица. Делаем универсальный.

BEGIN;

-- Универсальный 5min_before для мероприятий (без упоминания спикера)
INSERT INTO broadcast_templates
  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
SELECT
  e.client_id, e.id,
  'За 5 минут до старта',
  '5min_before',
  '<b>Через 5 минут стартует «{conf_title}»</b>' || E'\n\n' ||
  'Подключайтесь к эфиру 👇' || E'\n\n' ||
  '🔗 {stream_url}',
  NULL,
  'Подключиться к эфиру', '{stream_url}',
  'fixed_offset',
  5,
  'all_event', 'none',
  FALSE
  FROM events e
 WHERE e.module_slug <> 'conference'
   AND NOT EXISTS (SELECT 1 FROM broadcast_templates bt
                    WHERE bt.event_id = e.id AND bt.type = '5min_before');

-- За 2 часа (нерег) — для мероприятий
INSERT INTO broadcast_templates
  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
SELECT
  e.client_id, e.id,
  'За 2 часа (не зарегистрирован)',
  '2h_before_unreg',
  '<b>Через 2 часа стартует «{conf_title}»</b>' || E'\n\n' ||
  'Регистрируйтесь по кнопке — встретимся через пару часов!' || E'\n\n' ||
  '🔗 {landing_url}',
  NULL,
  'Зарегистрироваться', '{landing_url}',
  'fixed_offset',
  120,
  'all_client', 'registered_event',
  FALSE
  FROM events e
 WHERE e.module_slug <> 'conference'
   AND NOT EXISTS (SELECT 1 FROM broadcast_templates bt
                    WHERE bt.event_id = e.id AND bt.type = '2h_before_unreg');

-- За 2 часа (зарег) — для мероприятий
INSERT INTO broadcast_templates
  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
SELECT
  e.client_id, e.id,
  'За 2 часа (зарегистрирован)',
  '2h_before_reg',
  '<b>Через 2 часа стартует «{conf_title}»</b>' || E'\n\n' ||
  'Вы записаны — а пока есть время позвать друзей и забрать подарки за приведённых.',
  NULL,
  '🎯 Вы ещё успеваете позвать друзей и получить подарки', '{game_link}',
  'fixed_offset',
  120,
  'registered_event', 'none',
  FALSE
  FROM events e
 WHERE e.module_slug <> 'conference'
   AND NOT EXISTS (SELECT 1 FROM broadcast_templates bt
                    WHERE bt.event_id = e.id AND bt.type = '2h_before_reg');

COMMIT;
