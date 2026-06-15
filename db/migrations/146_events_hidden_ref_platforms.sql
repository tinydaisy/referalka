-- 146: возможность скрыть отдельные платформы из реф-ссылок события
-- Клиент может скрыть, например, VK из реф-ссылок события (если VK глючит),
-- НЕ удаляя сам VK-канал. hidden_ref_platforms — список платформ ('telegram',
-- 'vk', 'max'), которые НЕ показывать в реф-ссылках события. Пусто = показывать все.

ALTER TABLE events ADD COLUMN IF NOT EXISTS hidden_ref_platforms TEXT[] DEFAULT '{}'::text[];

COMMENT ON COLUMN events.hidden_ref_platforms IS 'Платформы, скрытые из реф-ссылок события (telegram/vk/max). Пусто = все.';
