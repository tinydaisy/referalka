-- 218_hub_card_impact_wow.sql
-- Коллабораторная (Хаб), карточка организатора = clients.
-- 1. Чистим МЁРТВЫЕ hub_* колонки с collaborators (реализация карточки ушла на clients
--    миграцией 135; код эти колонки не читает, данных нет кроме одной тестовой строки).
-- 2. Добавляем 2 новых поля карточки Хаба + галочки «показывать публично».

-- ─────────────────────────────────────────────────────────────
-- 1. Удаляем мёртвые hub_* с collaborators
-- ─────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_collaborators_hub;
ALTER TABLE collaborators
    DROP COLUMN IF EXISTS is_published_in_hub,
    DROP COLUMN IF EXISTS hub_category,
    DROP COLUMN IF EXISTS hub_niche,
    DROP COLUMN IF EXISTS hub_city,
    DROP COLUMN IF EXISTS hub_about,
    DROP COLUMN IF EXISTS hub_published_at;

-- ─────────────────────────────────────────────────────────────
-- 2. Новые поля карточки организатора в Хабе (на clients)
--    impact — «Что я создаю и меняю в стране/мире своей деятельностью и проектами?»
--    wow    — «Моя "капелька безумия" или WOW-факт»
--    *_public — показывать ли поле в ПУБЛИЧНОЙ карточке (каталог/профиль). Владелец
--    видит своё поле всегда, галочка управляет только показом другим.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS hub_impact        TEXT,
    ADD COLUMN IF NOT EXISTS hub_impact_public BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS hub_wow           TEXT,
    ADD COLUMN IF NOT EXISTS hub_wow_public    BOOLEAN NOT NULL DEFAULT TRUE;

-- GRANT не нужен — clients уже доступна роли plusson.
