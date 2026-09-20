-- 478. Удаление «общего режима ссылок» `clients.default_link_mode`.
-- Шаг 3 (после миграции 477 «перенос значений» и выката кода).
--
-- ПОЧЕМУ УДАЛЯЕМ, А НЕ ОСТАВЛЯЕМ.
-- Переключателя для этого поля в кабинете НИКОГДА не существовало: значение
-- проставлялось само (DEFAULT 'bot' при создании клиента). При этом часть кода
-- читала его вместо площадочных `link_mode_{telegram|vk|max}` — тех самых,
-- которые клиент настраивает в разделе Mini App. Настройка «Telegram: Вход
-- через Мини-апп» не действовала: `/menu{id}` открывал веб-версию.
--
-- Поле, которое нельзя настроить, но которое перебивает настройку, — источник
-- путаницы и для клиента, и для следующей сессии. Единственный источник истины
-- теперь один: режим ПЛОЩАДКИ.
--
-- ⚠️ Значения не потеряны: миграция 477 записала действовавший режим в
-- площадочные колонки у всех клиентов. Поведение не изменилось ни у кого.

BEGIN;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_default_link_mode_chk;
ALTER TABLE clients DROP COLUMN IF EXISTS default_link_mode;

-- Пустых значений после 477 не осталось, и появляться им больше незачем:
-- у нового клиента Mini App ещё не привязан, поэтому 'bot' (ссылка ведёт в
-- бота, человек подписывается сам) — верное начальное состояние.
ALTER TABLE clients ALTER COLUMN link_mode_telegram SET DEFAULT 'bot';
ALTER TABLE clients ALTER COLUMN link_mode_vk       SET DEFAULT 'bot';
ALTER TABLE clients ALTER COLUMN link_mode_max      SET DEFAULT 'bot';

UPDATE clients SET link_mode_telegram = 'bot' WHERE link_mode_telegram IS NULL;
UPDATE clients SET link_mode_vk       = 'bot' WHERE link_mode_vk       IS NULL;
UPDATE clients SET link_mode_max      = 'bot' WHERE link_mode_max      IS NULL;

ALTER TABLE clients ALTER COLUMN link_mode_telegram SET NOT NULL;
ALTER TABLE clients ALTER COLUMN link_mode_vk       SET NOT NULL;
ALTER TABLE clients ALTER COLUMN link_mode_max      SET NOT NULL;

COMMENT ON COLUMN clients.link_mode_telegram IS
    'Куда ведут ссылки события в Telegram: miniapp — Mini App клиента; bot — '
    'в бота + веб-страница. Настраивается в кабинете → Mini App. ⚠️ Другого '
    '(«общего») режима НЕТ: поле default_link_mode удалено миграцией 478';

COMMIT;
