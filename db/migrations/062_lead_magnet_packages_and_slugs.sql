-- Миграция 062 (05.05.2026): пакеты лид-магнитов + slug у лид-магнитов
--
-- Что добавляем:
--   1) lead_magnets.slug — короткий 5-символьный код для публичной ссылки
--      pluson.ru/m/{slug}. UNIQUE по всей таблице (короткий неймспейс на всех клиентов).
--   2) lead_magnet_packages — пакеты, объединение нескольких лид-магнитов под одним
--      названием и одной ссылкой pluson.ru/p/{slug}.
--   3) lead_magnet_package_items — состав пакета (M2M).

BEGIN;

-- 1. Slug у одиночных лид-магнитов
ALTER TABLE lead_magnets
  ADD COLUMN IF NOT EXISTS slug TEXT;

-- Заполняем slug для существующих записей короткими случайными кодами
DO $$
DECLARE
    r RECORD;
    new_slug TEXT;
    alphabet TEXT := '23456789abcdefghjkmnpqrstuvwxyz';
    attempts INT;
BEGIN
    FOR r IN SELECT id FROM lead_magnets WHERE slug IS NULL LOOP
        attempts := 0;
        LOOP
            new_slug := '';
            FOR i IN 1..5 LOOP
                new_slug := new_slug || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
            END LOOP;
            IF NOT EXISTS (SELECT 1 FROM lead_magnets WHERE slug = new_slug) THEN
                UPDATE lead_magnets SET slug = new_slug WHERE id = r.id;
                EXIT;
            END IF;
            attempts := attempts + 1;
            IF attempts > 50 THEN
                RAISE EXCEPTION 'Не удалось подобрать уникальный slug для lead_magnet id=%', r.id;
            END IF;
        END LOOP;
    END LOOP;
END $$;

ALTER TABLE lead_magnets
  ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lead_magnets_slug_uidx ON lead_magnets(slug);

-- 2. Пакеты лид-магнитов
CREATE TABLE IF NOT EXISTS lead_magnet_packages (
    id           BIGSERIAL PRIMARY KEY,
    client_id    INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    slug         TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_magnet_packages_client_idx
    ON lead_magnet_packages(client_id);

-- 3. Состав пакета
CREATE TABLE IF NOT EXISTS lead_magnet_package_items (
    package_id      BIGINT NOT NULL REFERENCES lead_magnet_packages(id) ON DELETE CASCADE,
    lead_magnet_id  INT NOT NULL REFERENCES lead_magnets(id) ON DELETE CASCADE,
    sort_order      INT NOT NULL DEFAULT 0,
    PRIMARY KEY (package_id, lead_magnet_id)
);

CREATE INDEX IF NOT EXISTS lead_magnet_package_items_lm_idx
    ON lead_magnet_package_items(lead_magnet_id);

COMMIT;
