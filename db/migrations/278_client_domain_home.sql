-- 278: что открывается на КОРНЕ клиентского домена (миграция 270 — свои домены).
--
-- Проблема. На корне домена клиента открывался лендинг САМОГО ПЛЮСОНа: nginx
-- отдаёт всё неизвестное в Next.js, а там на `/` лежит наша продающая страница.
-- Клиент платил за свой домен и показывал на нём нашу рекламу с кнопкой
-- «зарегистрируйтесь». Работали только адреса с путём (/e/…, /speaker/… и т.д.).
--
-- Теперь клиент сам выбирает главную страницу:
--   about   — витрина, вкладка «О проекте» (?tab=about)         ← по умолчанию
--   events  — витрина его событий  (/o/{client_id})
--   event   — лендинг конкретного события (/e/{slug} этого события)
--
-- Дефолт `about`, а не календарь: на главную заходит человек, который про
-- клиента ещё ничего не знает — ему сначала визитка, кто это и чем полезен,
-- а события он посмотрит соседней вкладкой.
--
-- ⚠️ home_event_id без ON DELETE CASCADE, а SET NULL: удалённое событие не
-- должно уносить с собой настройку домена. Слетело на NULL → корень отдаёт
-- витрину (см. резолвер), а не 404.

ALTER TABLE client_domains
    ADD COLUMN IF NOT EXISTS home_kind TEXT NOT NULL DEFAULT 'about',
    ADD COLUMN IF NOT EXISTS home_event_id INTEGER
        REFERENCES events(id) ON DELETE SET NULL;

-- Колонка могла быть создана с прежним дефолтом 'events' — приводим к 'about'
-- и переводим уже существующие домены, которые ещё никто не настраивал.
ALTER TABLE client_domains ALTER COLUMN home_kind SET DEFAULT 'about';
UPDATE client_domains SET home_kind = 'about'
 WHERE kind = 'landing' AND home_kind = 'events';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'client_domains_home_kind_chk'
    ) THEN
        ALTER TABLE client_domains
            ADD CONSTRAINT client_domains_home_kind_chk
            CHECK (home_kind IN ('events', 'about', 'event'));
    END IF;
END $$;

COMMENT ON COLUMN client_domains.home_kind IS
    'Что открывать на корне домена: events — витрина, about — витрина на вкладке «О проекте», event — лендинг события home_event_id';
COMMENT ON COLUMN client_domains.home_event_id IS
    'Событие для home_kind=event. NULL (например, событие удалили) → показываем витрину';
