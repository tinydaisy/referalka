-- 134_collaboratornaya.sql
-- Коллабораторная (Хаб) — биржа коллабораций.
-- 1. event_owners — много владельцев-клиентов на событие (co-ownership). Одиночное событие = 1 запись.
-- 2. Поля публичной карточки в Хабе на collaborators.
-- 3. Справочник ниш + история коллабораций + отзывы + рейтинг.
-- См. documentation/CONCEPT-COLLAB-NETWORK.md

-- ─────────────────────────────────────────────────────────────
-- 1. event_owners — владельцы (Организаторы) события
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_owners (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'accepted',   -- pending(серый) | accepted(зелёный) | declined
    role        TEXT NOT NULL DEFAULT 'owner',      -- owner(инициатор) | co_owner
    invited_by_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ,
    UNIQUE(event_id, client_id),
    CONSTRAINT event_owners_status_chk CHECK (status IN ('pending','accepted','declined')),
    CONSTRAINT event_owners_role_chk   CHECK (role IN ('owner','co_owner'))
);
CREATE INDEX IF NOT EXISTS idx_event_owners_event  ON event_owners(event_id);
CREATE INDEX IF NOT EXISTS idx_event_owners_client ON event_owners(client_id) WHERE status='accepted';

-- Бэкфилл: каждое существующее событие → один owner (текущий events.client_id). Старое поведение не меняется.
INSERT INTO event_owners (event_id, client_id, status, role)
SELECT id, client_id, 'accepted', 'owner'
  FROM events
 WHERE client_id IS NOT NULL
ON CONFLICT (event_id, client_id) DO NOTHING;

-- events.client_id ОСТАЁТСЯ (как "инициатор/основной владелец") для обратной совместимости ~28 мест.
-- Код читает владельцев через event_owners, но events.client_id не удаляем (минимизируем риск).

-- ─────────────────────────────────────────────────────────────
-- 2. Поля публичной карточки коллаборатора в Хабе
-- ─────────────────────────────────────────────────────────────
ALTER TABLE collaborators
    ADD COLUMN IF NOT EXISTS is_published_in_hub BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS hub_category        TEXT,   -- offline_business|online_business|freelancer|expert
    ADD COLUMN IF NOT EXISTS hub_niche           TEXT,   -- slug ниши (hub_niches.slug)
    ADD COLUMN IF NOT EXISTS hub_city            TEXT,   -- гео для матчинга офлайн-бизнеса
    ADD COLUMN IF NOT EXISTS hub_about           TEXT,   -- «о себе» для каталога
    ADD COLUMN IF NOT EXISTS hub_published_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_collaborators_hub ON collaborators(is_published_in_hub) WHERE is_published_in_hub;

-- ─────────────────────────────────────────────────────────────
-- 3. Справочник ниш
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hub_niches (
    id    SERIAL PRIMARY KEY,
    slug  TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
);
INSERT INTO hub_niches (slug, title, sort_order) VALUES
    ('psychology',  'Психология',        10),
    ('health',      'Здоровье',          20),
    ('spirituality','Духовность',        30),
    ('finance',     'Финансы',           40),
    ('investment',  'Инвестиции',        50),
    ('sport',       'Спорт',             60),
    ('business',    'Бизнес',            70),
    ('marketing',   'Продажи/маркетинг', 80),
    ('relations',   'Отношения',         90),
    ('creativity',  'Творчество',       100),
    ('purpose',     'Предназначение',   110)
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 4. Запросы на коллаборацию (отдельно от event_owners — запрос может быть без события или вести к нему)
--    Здесь — лёгкие запросы из Хаба между клиентами. Принятие создаёт co_owner в event_owners.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hub_collab_requests (
    id              SERIAL PRIMARY KEY,
    from_client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    to_client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    event_id        INTEGER REFERENCES events(id) ON DELETE CASCADE,  -- к какому событию (может быть NULL — общий запрос)
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined
    message         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at    TIMESTAMPTZ,
    CONSTRAINT hub_collab_requests_status_chk CHECK (status IN ('pending','accepted','declined'))
);
CREATE INDEX IF NOT EXISTS idx_hub_requests_to   ON hub_collab_requests(to_client_id)   WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_hub_requests_from ON hub_collab_requests(from_client_id);

-- ─────────────────────────────────────────────────────────────
-- 5. История коллабораций (для рейтинга и карточки)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hub_collab_history (
    id                 SERIAL PRIMARY KEY,
    client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,  -- чей вклад
    event_id           INTEGER REFERENCES events(id) ON DELETE SET NULL,
    partner_client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,          -- с кем коллабился
    participants_total INTEGER NOT NULL DEFAULT 0,  -- всего на событии
    brought_live       INTEGER NOT NULL DEFAULT 0,  -- сколько живых привёл он
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hub_history_client ON hub_collab_history(client_id);

-- ─────────────────────────────────────────────────────────────
-- 6. Отзывы о коллабораторе (клиенте)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hub_reviews (
    id               SERIAL PRIMARY KEY,
    client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,  -- о ком отзыв
    author_client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,  -- кто оставил
    rating           SMALLINT NOT NULL,
    text             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(client_id, author_client_id),
    CONSTRAINT hub_reviews_rating_chk CHECK (rating BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_hub_reviews_client ON hub_reviews(client_id);

-- ─────────────────────────────────────────────────────────────
-- 7. Опциональный рычаг «перелива» — обязательная подписка на всех организаторов совместного события
-- ─────────────────────────────────────────────────────────────
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS is_collab BOOLEAN NOT NULL DEFAULT FALSE,            -- это коллаб-событие (>1 owner)
    ADD COLUMN IF NOT EXISTS require_subscribe_all_owners BOOLEAN NOT NULL DEFAULT FALSE;  -- рычаг перелива

-- GRANTы (роль БД = plusson)
GRANT SELECT, INSERT, UPDATE, DELETE ON event_owners, hub_niches, hub_collab_requests, hub_collab_history, hub_reviews TO plusson;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plusson;
