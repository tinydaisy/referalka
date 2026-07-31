-- 264. Настройки Коллабораторной, задаваемые администратором платформы.
--
-- Пока здесь одно поле — ссылка на закрытый Telegram-чат участников. Чат один
-- на всю Коллабораторную, поэтому таблица-одиночка (id = 1), как у
-- referral_program_settings.
--
-- ⚠️ Ссылка настраиваемая, а не зашитая в код: инвайт-ссылку Telegram
-- приходится отзывать и выпускать заново, и каждый раз выкатывать деплой ради
-- этого нельзя.

CREATE TABLE IF NOT EXISTS collab_hub_settings (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    chat_url    TEXT,
    chat_title  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT collab_hub_settings_single CHECK (id = 1)
);

INSERT INTO collab_hub_settings (id, chat_url, chat_title)
VALUES (1, 'https://t.me/+MvQGIirJ0a42MzMy', 'Закрытый чат')
ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON collab_hub_settings TO plusson;
