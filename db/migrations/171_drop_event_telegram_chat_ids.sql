-- Миграция 171: удаление legacy-поля events.telegram_chat_ids (CSV «ID Telegram-каналов»).
--
-- Поле было отдельным от tg_chat_id и использовалось только кнопкой «Проверить чаты».
-- Теперь проверка членства идёт по чату СОБЫТИЯ (events.tg_chat_id), а внешние чаты
-- для рассылок переехали в Каналы → «Чаты для рассылок» (client_broadcast_chats).
-- Поле убрано из фронта и API; колонку удаляем.

ALTER TABLE events DROP COLUMN IF EXISTS telegram_chat_ids;
