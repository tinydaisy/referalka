-- Миграция 060 (05.05.2026): унификация движка рассылок для мероприятий и конференций
--
-- ЧТО ДЕЛАЕТ:
--   1. contacts.ref_code → NOT NULL (уже у всех заполнено, контракт жёстче)
--   2. Переименование исторически кривых имён типов шаблонов и расписаний:
--      - day_start_30min_unreg → 2h_before_unreg (фактически уже за 2 часа с миграции 027)
--      - day_start_30min_reg   → 2h_before_reg
--      - pre_start             → 5min_before    (за 5 мин до сессии/события)
--   3. Сидирование новых типов шаблонов для всех существующих событий:
--      - 30min_before                — общий, для конф (за 30 мин до старта дня) и мероприятий (за 30 мин до start_at)
--      - day_before_09_12_unreg/reg  — только для не-конференций (для конф эту роль играет pre_conf)
--   4. Обновление человекочитаемых name шаблонов под новые имена.
--
-- НЕ ТРОГАЕТ: pre_conf, gift, day_live, day_end, speaker_intro, vip_offer (специфика конференций).

BEGIN;

-- ── 1. contacts.ref_code → NOT NULL ────────────────────────────────────────
-- Гарантия уже выполнена SELECT'ом перед миграцией: 0 контактов без ref_code.
ALTER TABLE contacts ALTER COLUMN ref_code SET NOT NULL;

-- ── 2. Переименование типов шаблонов и расписаний ───────────────────────────
UPDATE broadcast_templates  SET type = '2h_before_unreg' WHERE type = 'day_start_30min_unreg';
UPDATE broadcast_templates  SET type = '2h_before_reg'   WHERE type = 'day_start_30min_reg';
UPDATE broadcast_templates  SET type = '5min_before'     WHERE type = 'pre_start';

UPDATE broadcast_schedules  SET type = '2h_before_unreg' WHERE type = 'day_start_30min_unreg';
UPDATE broadcast_schedules  SET type = '2h_before_reg'   WHERE type = 'day_start_30min_reg';
UPDATE broadcast_schedules  SET type = '5min_before'     WHERE type = 'pre_start';

-- Обновляем name (приставка «День конференции» → ничего, у мероприятий тоже же шаблон)
UPDATE broadcast_templates
   SET name = 'За 2 часа (не зарегистрирован)'
 WHERE type = '2h_before_unreg' AND name LIKE 'День конференции%';
UPDATE broadcast_templates
   SET name = 'За 2 часа (зарегистрирован)'
 WHERE type = '2h_before_reg' AND name LIKE 'День конференции%';
UPDATE broadcast_templates
   SET name = 'За 5 минут до старта'
 WHERE type = '5min_before' AND name LIKE 'Анонс спикера%';

-- ── 3. Сидинг новых типов для существующих событий ─────────────────────────
-- 3a. 30min_before — для всех событий клиента (конф + мероприятия)
INSERT INTO broadcast_templates
  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
SELECT
  e.client_id, e.id,
  'За 30 минут до старта',
  '30min_before',
  '<b>Через 30 минут стартует «{conf_title}»</b>' || E'\n\n' ||
  'Подключайтесь к эфиру по кнопке ниже 👇' || E'\n\n' ||
  '🔗 {stream_url}',
  NULL,
  'Подключиться к эфиру', '{stream_url}',
  CASE WHEN e.module_slug = 'conference' THEN 'day_offset' ELSE 'fixed_offset' END,
  30,
  'all_event', 'none',
  FALSE
  FROM events e
 WHERE NOT EXISTS (
   SELECT 1 FROM broadcast_templates bt
    WHERE bt.event_id = e.id AND bt.type = '30min_before'
 );

-- 3b. day_before_09_12_unreg + day_before_09_12_reg — только для не-конференций
INSERT INTO broadcast_templates
  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
SELECT
  e.client_id, e.id,
  'За сутки в 09:12 МСК (не зарегистрирован)',
  'day_before_09_12_unreg',
  '<b>Завтра «{conf_title}»</b>' || E'\n\n' ||
  'Регистрируйтесь по кнопке — встретимся завтра!' || E'\n\n' ||
  '🔗 {landing_url}',
  NULL,
  'Зарегистрироваться', '{landing_url}',
  'fixed_offset',
  1440,
  'all_client', 'registered_event',
  FALSE
  FROM events e
 WHERE e.module_slug <> 'conference'
   AND NOT EXISTS (
     SELECT 1 FROM broadcast_templates bt
      WHERE bt.event_id = e.id AND bt.type = 'day_before_09_12_unreg'
   );

INSERT INTO broadcast_templates
  (client_id, event_id, name, type, text, photo_url, button_text, button_url,
   schedule_mode, offset_minutes, audience_include, audience_exclude, allow_custom_datetime)
SELECT
  e.client_id, e.id,
  'За сутки в 09:12 МСК (зарегистрирован)',
  'day_before_09_12_reg',
  '<b>Завтра «{conf_title}»</b>' || E'\n\n' ||
  'Вы записаны — а пока есть время позвать друзей и забрать подарки за приведённых:',
  NULL,
  '🎯 Вы ещё успеваете позвать друзей и получить подарки', '{game_link}',
  'fixed_offset',
  1440,
  'registered_event', 'none',
  FALSE
  FROM events e
 WHERE e.module_slug <> 'conference'
   AND NOT EXISTS (
     SELECT 1 FROM broadcast_templates bt
      WHERE bt.event_id = e.id AND bt.type = 'day_before_09_12_reg'
   );

-- ── 4. Кнопки на 2h_before_reg → переключаем на {game_link} ─────────────────
-- Ранее у зарегистрированных кнопка вела в эфир, но за 2 часа эфира ещё нет.
-- Логичнее предложить позвать друзей через свой партнёрский кабинет.
UPDATE broadcast_templates
   SET button_text = '🎯 Вы ещё успеваете позвать друзей и получить подарки',
       button_url  = '{game_link}'
 WHERE type = '2h_before_reg'
   AND (button_url IS NULL OR button_url = '{stream_url}' OR button_url = '');

COMMIT;
