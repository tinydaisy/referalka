-- 293: Лендинг может принадлежать не только событию (2026-08-13)
--
-- Зачем. Конструктор блоков (миграция 240) жёстко привязан к `event_id`.
-- Продукты (миграция 290) продаются со своей страницы `/pr/{slug}`, и им
-- нужен ТОТ ЖЕ конструктор: заводить второй набор блоков и вторую вёрстку —
-- значит развести их и потом чинить в двух местах.
--
-- ⚠️ Блоки (`event_landing_blocks`) НЕ ТРОГАЕМ вообще: они висят на `page_id`,
-- а не на событии. Владелец меняется только у страницы.
--
-- Что делаем:
--   • `owner_type` + `owner_id` — чья это страница ('event' | 'product');
--   • `client_id` — чтобы публичная отдача и сборка ссылок не ходили за
--     владельцем через event_owners каждый раз;
--   • `slug` — свой адрес страницы. У события адрес берётся из `events.slug`,
--     у продукта — из `products.slug`; поле нужно на будущее, для страниц,
--     у которых своего владельца-с-адресом нет (визитка, медиакит).
--
-- Совместимость: у всех существующих строк `owner_type='event'`, `event_id`
-- остаётся заполненным. Старый код, читающий по `event_id`, работает как был.

BEGIN;

ALTER TABLE event_landing_pages
    ADD COLUMN IF NOT EXISTS owner_type TEXT NOT NULL DEFAULT 'event'
        CHECK (owner_type IN ('event', 'product')),
    ADD COLUMN IF NOT EXISTS owner_id   INTEGER,
    ADD COLUMN IF NOT EXISTS client_id  INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS slug       TEXT;

-- Бэкфилл: всё, что есть, — страницы событий.
UPDATE event_landing_pages SET owner_id = event_id WHERE owner_id IS NULL;

-- client_id берём у владельца события (у `events` своего client_id нет —
-- владение живёт в event_owners со status='accepted').
UPDATE event_landing_pages p
   SET client_id = eo.client_id
  FROM event_owners eo
 WHERE eo.event_id = p.event_id
   AND eo.status = 'accepted'
   AND p.client_id IS NULL;

-- ⚠️ event_id становится NULL-able: у страницы продукта события нет.
ALTER TABLE event_landing_pages ALTER COLUMN event_id DROP NOT NULL;

-- Старое ограничение «одна страница каждого вида на событие» заменяем на
-- частичные индексы по владельцу — иначе у продуктов оно бы не работало.
ALTER TABLE event_landing_pages DROP CONSTRAINT IF EXISTS event_landing_pages_event_id_kind_key;

CREATE UNIQUE INDEX IF NOT EXISTS event_landing_pages_event_kind_uniq
    ON event_landing_pages (event_id, kind)
    WHERE owner_type = 'event';

CREATE UNIQUE INDEX IF NOT EXISTS event_landing_pages_owner_kind_uniq
    ON event_landing_pages (owner_type, owner_id, kind)
    WHERE owner_type <> 'event';

CREATE INDEX IF NOT EXISTS idx_event_landing_pages_owner
    ON event_landing_pages (owner_type, owner_id);

COMMENT ON COLUMN event_landing_pages.owner_type IS
    'Чья страница: event (событие) | product (продукт). Блоки висят на page_id и владельца не знают';
COMMENT ON COLUMN event_landing_pages.client_id IS
    'Владелец страницы. У событий бэкфиллен из event_owners(accepted)';

COMMIT;
