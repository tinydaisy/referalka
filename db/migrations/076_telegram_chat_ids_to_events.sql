-- Перенос поля telegram_chat_ids из conf_conferences в events.
--
-- Контекст: у конференций было поле «ID Telegram-чатов/каналов события»
-- (через запятую), которое использовалось в рассылках для добавления копии
-- в дополнительные чаты. Логика «чат + его ID-ы» одинаковая для конференций
-- и обычных мероприятий — поэтому поле переезжает в общую таблицу events,
-- рядом с chat_url / chat_subscriptions_required / chat_member_count_label.

BEGIN;

ALTER TABLE events ADD COLUMN IF NOT EXISTS telegram_chat_ids TEXT;

UPDATE events e
   SET telegram_chat_ids = cc.telegram_chat_ids
  FROM conf_conferences cc
 WHERE e.id = cc.event_id
   AND cc.telegram_chat_ids IS NOT NULL
   AND cc.telegram_chat_ids <> ''
   AND (e.telegram_chat_ids IS NULL OR e.telegram_chat_ids = '');

ALTER TABLE conf_conferences DROP COLUMN IF EXISTS telegram_chat_ids;

COMMIT;
