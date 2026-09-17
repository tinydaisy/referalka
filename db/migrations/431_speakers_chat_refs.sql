-- 431: Чат спикеров у события (конференция / премия / турнир).
--
-- Отдельный от чата участников закрытый чат, куда бот пишет спикерам
-- служебные сообщения — в первую очередь «вы следующие» за 15 минут до
-- выступления по программе (тип рассылки speakers_call).
--
-- Модель ТА ЖЕ, что у чатов события (миграция 174): не храним chat_id,
-- а ссылаемся на запись в базе чатов клиента client_broadcast_chats.
-- Клиент добавляет чат один раз в Каналы → «Группы/Каналы для рассылок»,
-- а в событии только выбирает его из списка.
--
-- Три площадки — потому что чат спикеров может жить в любой одной из них:
-- у кого-то команда сидит в Telegram, у кого-то в MAX. Заполняется столько,
-- сколько нужно; рассылка уходит в каждый заполненный.
--
-- У мероприятия (module_slug base/medialift) спикеров нет — поля остаются
-- пустыми и в кабинете не показываются.

ALTER TABLE events ADD COLUMN IF NOT EXISTS tg_speakers_chat_ref  INTEGER NULL
    REFERENCES client_broadcast_chats(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS vk_speakers_chat_ref  INTEGER NULL
    REFERENCES client_broadcast_chats(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_speakers_chat_ref INTEGER NULL
    REFERENCES client_broadcast_chats(id) ON DELETE SET NULL;

COMMENT ON COLUMN events.tg_speakers_chat_ref  IS 'Чат спикеров (Telegram) → client_broadcast_chats.id';
COMMENT ON COLUMN events.vk_speakers_chat_ref  IS 'Чат спикеров (ВКонтакте) → client_broadcast_chats.id';
COMMENT ON COLUMN events.max_speakers_chat_ref IS 'Чат спикеров (MAX) → client_broadcast_chats.id';
