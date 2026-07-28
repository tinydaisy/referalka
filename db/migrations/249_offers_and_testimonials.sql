-- 249: База оферт + база отзывов и кейсов (для лендингов и продаж).
--
-- ЗАЧЕМ. Оферта у события была одной ссылкой (`events.offer_url`) — под каждый
-- продукт свою не завести, текст жил на стороннем сайте. Отзывы и кейсы вообще
-- нигде не хранились: чтобы поставить их на лендинг, клиент каждый раз заново
-- загружал файлы в конкретный блок, и переиспользовать их было нельзя.
--
-- Обе базы — общие для клиента (как лид-магниты), а не привязаны к событию:
-- один отзыв нужен и на лендинге конференции, и в рассылке, и на странице
-- следующего события. Привязка к событию — необязательная пометка.
--
-- Гейт — по ФИЧАМ (правило: никогда по tariff_slug), по отдельной на каждую:
--   `offers`       — раздел «Оферты»
--   `testimonials` — раздел «Отзывы и кейсы»
-- Обе выдаются тарифу «Администратор».

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Оферты
-- ─────────────────────────────────────────────────────────────────────────────
-- `body` — текст документа (HTML). Публичная страница отдаётся по slug:
-- pluson.ru/o/{slug} — ссылка живёт у нас, а не на чужом домене.
-- `external_url` — если у клиента оферта уже лежит снаружи, показываем её.
CREATE TABLE IF NOT EXISTS client_offers (
    id            SERIAL PRIMARY KEY,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    slug          TEXT NOT NULL,
    body          TEXT,
    external_url  TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_client_offers_client ON client_offers(client_id);

-- Какую оферту показывать у события и у конкретного тарифа.
-- ⚠️ `events.offer_url` остаётся: у кого он заполнен — работает как раньше,
-- новая привязка приоритетнее.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS offer_id INTEGER REFERENCES client_offers(id) ON DELETE SET NULL;
ALTER TABLE event_tariffs
  ADD COLUMN IF NOT EXISTS offer_id INTEGER REFERENCES client_offers(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Отзывы и кейсы
-- ─────────────────────────────────────────────────────────────────────────────
-- `kind`: photo — скриншот отзыва / фото; video — видеоотзыв по ссылке
--         (YouTube, VK, Rutube) или файлом в R2.
-- `tags`  — свободные метки («конференция», «частушки», «ivision-8»): по ним
--           отзывы отбираются в галерею лендинга.
-- `event_id` — необязательная пометка «с какого события».
CREATE TABLE IF NOT EXISTS client_testimonials (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video')),
    url         TEXT NOT NULL,              -- картинка в R2 либо ссылка на видео
    preview_url TEXT,                       -- обложка видео
    title       TEXT,                       -- чей отзыв / о чём кейс
    caption     TEXT,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    event_id    INTEGER REFERENCES events(id) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_testimonials_client ON client_testimonials(client_id, sort_order);
-- Поиск по тегам — GIN, иначе фильтр галереи будет сканировать всю таблицу.
CREATE INDEX IF NOT EXISTS idx_testimonials_tags ON client_testimonials USING GIN (tags);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Галерея лендинга берёт отзывы из базы
-- ─────────────────────────────────────────────────────────────────────────────
-- `source`: manual — картинки загружены прямо в блок (как было);
--           testimonials — берутся из базы отзывов по тегам.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS gallery_source TEXT NOT NULL DEFAULT 'manual'
        CHECK (gallery_source IN ('manual', 'testimonials')),
  ADD COLUMN IF NOT EXISTS gallery_tags TEXT[] NOT NULL DEFAULT '{}';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Фичи доступа
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO features (slug, name, description, sort) VALUES
  ('offers', 'Оферты',
   'Раздел «Оферты»: свои тексты договоров, разные оферты на разные продукты.', 92),
  ('testimonials', 'Отзывы и кейсы',
   'База отзывов и кейсов: фото и видео с тегами, подставляются в галерею лендинга.', 93)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug IN ('offers', 'testimonials')
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON client_offers        TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON client_testimonials  TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_offers_id_seq         TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_testimonials_id_seq   TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
