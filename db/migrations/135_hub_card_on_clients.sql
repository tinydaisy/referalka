-- 135_hub_card_on_clients.sql
-- ИСПРАВЛЕНИЕ архитектуры карточки Хаба: карточка организатора = профиль КЛИЕНТА (clients),
-- а НЕ карточка коллаборатора (collaborators — это спикеры/жюри, другой слой).
-- Переносим хаб-поля с collaborators на clients + добавляем media_assets клиенту.

-- 1. Хаб-поля на clients (карточка организатора в бирже)
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS is_published_in_hub BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS hub_category        TEXT,   -- offline_business|online_business|freelancer|expert
    ADD COLUMN IF NOT EXISTS hub_niche           TEXT,
    ADD COLUMN IF NOT EXISTS hub_city            TEXT,
    ADD COLUMN IF NOT EXISTS hub_about           TEXT,
    ADD COLUMN IF NOT EXISTS hub_published_at    TIMESTAMPTZ,
    -- медийность организатора: [{platform, subscribers}] — как у collaborators.media_assets
    ADD COLUMN IF NOT EXISTS media_assets        JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_clients_hub ON clients(is_published_in_hub) WHERE is_published_in_hub;

-- 2. Откатываем ошибочные хаб-поля с collaborators (они там не нужны — карточка не оттуда).
--    Колонки оставляем (вдруг где-то прочитаются), но снимаем публикацию, чтобы каталог их не показывал.
UPDATE collaborators SET is_published_in_hub = FALSE WHERE is_published_in_hub = TRUE;

-- GRANT не нужен — clients уже доступна роли plusson.
