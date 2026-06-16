-- Миграция 149: числовые ID бесед ВК и МАХ для слушалки чатов.
-- Для TG уже есть events.telegram_chat_ids (CSV). Для ВК/МАХ бесед в БД были
-- только ссылки-приглашения (chat_url_vk/max) — по ним беседу не опознать.
-- Эти поля хранят числовой chat_id беседы (узнаётся командой /chatid в беседе).

ALTER TABLE events ADD COLUMN IF NOT EXISTS vk_chat_id  TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_chat_id TEXT;

COMMENT ON COLUMN events.vk_chat_id  IS 'Числовой chat_id ВК-беседы события (для слушалки чатов). peer_id беседы = 2000000000 + chat_id.';
COMMENT ON COLUMN events.max_chat_id IS 'Числовой chat_id МАХ-беседы события (для слушалки чатов).';
