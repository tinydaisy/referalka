-- 175: текст меню события в чат-боте (send_event_menu)
-- Клиент может переопределить текст сообщения-меню, которое бот шлёт
-- зарегистрированному участнику (и по команде /menu{id}).
-- NULL = использовать дефолтный текст из кода.
-- Плейсхолдер {title} в тексте заменяется на название события.

ALTER TABLE events ADD COLUMN IF NOT EXISTS bot_menu_text TEXT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON events TO plusson;
