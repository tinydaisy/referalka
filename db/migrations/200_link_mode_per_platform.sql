-- Миграция 200: режим открытия ссылок — ОТДЕЛЬНО НА КАЖДУЮ ПЛОЩАДКУ.
--
-- Проблема. `clients.default_link_mode` — одна настройка на весь кабинет
-- ('miniapp' | 'bot'). Но Mini App может быть подключён в Telegram и НЕ подключён
-- во ВКонтакте (или наоборот). Тогда на одной площадке ссылки живые, а на другой
-- ведут в никуда: `?startapp=` ничего не открывает, а бот в режиме miniapp молчит.
--
-- Решение. Отдельный режим на площадку. Значение NULL = «наследовать общий
-- default_link_mode» (обратная совместимость: ничего не меняется, пока клиент
-- не задал режим для конкретной площадки).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS link_mode_telegram TEXT
    CHECK (link_mode_telegram IN ('miniapp', 'bot')),
  ADD COLUMN IF NOT EXISTS link_mode_vk TEXT
    CHECK (link_mode_vk IN ('miniapp', 'bot')),
  ADD COLUMN IF NOT EXISTS link_mode_max TEXT
    CHECK (link_mode_max IN ('miniapp', 'bot'));

COMMENT ON COLUMN clients.link_mode_telegram IS
  'Режим открытия ссылок в Telegram. NULL = наследовать default_link_mode.';
COMMENT ON COLUMN clients.link_mode_vk IS
  'Режим открытия ссылок во ВКонтакте. NULL = наследовать default_link_mode.';
COMMENT ON COLUMN clients.link_mode_max IS
  'Режим открытия ссылок в MAX. NULL = наследовать default_link_mode.';

-- Сервисный клиент: у @pluson_bot Mini App привязан отдельным short-name
-- (`t.me/pluson_bot/pluson`), а VK-приложения у него нет — там только бот-флоу.
UPDATE clients SET link_mode_vk = 'bot' WHERE is_system_service = TRUE;
