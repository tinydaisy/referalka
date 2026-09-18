-- 437: Чат спикеров задаётся ВРУЧНУЮ по ID, а не выбором из базы чатов клиента.
--
-- ⚠️ ЗАМЕНЯЕТ подход миграции 431 (tg/vk/max_speakers_chat_ref → client_broadcast_chats).
-- Почему заменяем (решение владельца 18.09.2026): база чатов клиента — это чаты
-- для РАССЫЛОК по аудитории, их туда добавляют осознанно и надолго. Чат спикеров
-- живёт иначе: он служебный, часто заводится под конкретное событие и в общую
-- базу ему попадать незачем. Организатор просто вставляет ID, полученный
-- командой /getmyid прямо в этом чате (работает в TG, VK и MAX).
--
-- Поля на каждую площадку:
--   *_speakers_chat_id  — куда шлёт бот (обязательное для работы рассылки);
--   *_speakers_chat_url — ссылка на чат, ТОЛЬКО ДЛЯ СПРАВКИ. Нигде в отправке
--                         не участвует: чтобы организатор мог из кабинета
--                         быстро открыть нужный чат и не искать его по всем
--                         площадкам.
--
-- VK: ID беседы — это полный peer_id (2000000000 + номер), /getmyid его и отдаёт.

ALTER TABLE events ADD COLUMN IF NOT EXISTS tg_speakers_chat_id   TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS vk_speakers_chat_id   TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_speakers_chat_id  TEXT;

ALTER TABLE events ADD COLUMN IF NOT EXISTS tg_speakers_chat_url  TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS vk_speakers_chat_url  TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_speakers_chat_url TEXT;

COMMENT ON COLUMN events.tg_speakers_chat_id  IS 'ID чата спикеров (Telegram) — вводится вручную, /getmyid в чате';
COMMENT ON COLUMN events.vk_speakers_chat_id  IS 'ID беседы спикеров (VK) — полный peer_id (2000000000+N)';
COMMENT ON COLUMN events.max_speakers_chat_id IS 'ID чата спикеров (MAX) — вводится вручную, /getmyid в чате';
COMMENT ON COLUMN events.tg_speakers_chat_url IS 'Ссылка на чат спикеров (TG) — справочно, в отправке не участвует';
COMMENT ON COLUMN events.vk_speakers_chat_url IS 'Ссылка на чат спикеров (VK) — справочно, в отправке не участвует';
COMMENT ON COLUMN events.max_speakers_chat_url IS 'Ссылка на чат спикеров (MAX) — справочно, в отправке не участвует';

-- Переносим то, что успели выбрать через прежний ref-подход (миграция 431),
-- чтобы уже настроенные события не потеряли чат.
UPDATE events e SET tg_speakers_chat_id = c.chat_id, tg_speakers_chat_url = c.chat_url
  FROM client_broadcast_chats c
 WHERE c.id = e.tg_speakers_chat_ref AND e.tg_speakers_chat_id IS NULL;
UPDATE events e SET vk_speakers_chat_id = c.chat_id, vk_speakers_chat_url = c.chat_url
  FROM client_broadcast_chats c
 WHERE c.id = e.vk_speakers_chat_ref AND e.vk_speakers_chat_id IS NULL;
UPDATE events e SET max_speakers_chat_id = c.chat_id, max_speakers_chat_url = c.chat_url
  FROM client_broadcast_chats c
 WHERE c.id = e.max_speakers_chat_ref AND e.max_speakers_chat_id IS NULL;

-- Старые ref-колонки НЕ удаляем этой миграцией: DROP COLUMN не пускается в
-- автонакат (deploy/migrate.sh, раздел risky), а данные уже перенесены выше.
-- Код их больше не читает. Удалить можно отдельно и вручную, когда убедимся,
-- что всё работает.
