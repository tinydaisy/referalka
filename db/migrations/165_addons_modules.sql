-- Миграция 165: Модули-аддоны (расширение над тарифом) + чистка тарифов.
--
-- Концепция (по аналогии с «расширением над событием»: events + conf_conferences):
--   tariffs + tariff_features      = БАЗА (тариф со своим набором фич)
--   client_addons                  = РАСШИРЕНИЕ (фича, докупленная ЛИЧНО клиентом)
--   client_has_feature = фича в тарифе ИЛИ активный аддон.
-- Строка в client_addons рождается ТОЛЬКО при покупке — лишних записей нет.
--
-- Модули-аддоны (is_addon=TRUE): collab_hub, conference, tournaments.
-- Доступны к покупке только при тарифе Профи и выше (min_tariff_slug='pro').
-- Оплата — через Продамус (addon_orders + webhook, зеркало subscription_orders).

-- ───────────────────────────────────────────────────────────────────────────
-- 1) Чистка тарифов: переводим #6 и #12 на профи, скрываем Старт.
-- ───────────────────────────────────────────────────────────────────────────
WITH pro AS (SELECT id, default_duration_days FROM tariffs WHERE slug = 'pro')
UPDATE client_subscriptions cs
   SET tariff_id  = (SELECT id FROM pro),
       expires_at = NOW() + ((SELECT default_duration_days FROM pro) || ' days')::interval,
       status     = 'active',
       source     = 'admin',
       updated_at = NOW()
 WHERE cs.client_id IN (6, 12)
   AND cs.id = (SELECT current_subscription_id FROM clients WHERE id = cs.client_id);

UPDATE clients c
   SET current_subscription_id = (
        SELECT cs.id FROM client_subscriptions cs
         WHERE cs.client_id = c.id AND cs.status = 'active'
         ORDER BY cs.expires_at DESC, cs.id DESC LIMIT 1)
 WHERE c.id IN (6, 12);

-- Скрываем Старт с лендинга и из покупки (существующих на нём больше нет).
UPDATE tariffs SET is_active = FALSE WHERE slug = 'start';

-- ───────────────────────────────────────────────────────────────────────────
-- 2) Новая фича-модуль: tournaments (Премии / Турниры).
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO features (slug, name, description, sort)
VALUES ('tournaments', 'Премии и Турниры',
        'Жюри, турнирные таблицы, оценка участников, автоотслеживание заданий в чатах.', 90)
ON CONFLICT (slug) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- 3) Поля модуля на features (для лендинга и продажи аддонов).
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE features ADD COLUMN IF NOT EXISTS is_addon        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE features ADD COLUMN IF NOT EXISTS price_monthly   INTEGER;          -- ₽/мес
ALTER TABLE features ADD COLUMN IF NOT EXISTS price_6mo       INTEGER;          -- ₽/мес при оплате за 6 мес (−20%)
ALTER TABLE features ADD COLUMN IF NOT EXISTS min_tariff_slug TEXT;             -- мин. тариф для покупки
ALTER TABLE features ADD COLUMN IF NOT EXISTS tagline         TEXT;             -- подзаголовок карточки
ALTER TABLE features ADD COLUMN IF NOT EXISTS bullet_points   JSONB NOT NULL DEFAULT '[]'::jsonb;  -- список «что входит»
ALTER TABLE features ADD COLUMN IF NOT EXISTS prodamus_payment_url TEXT;        -- ссылка оплаты Продамус (мес)
ALTER TABLE features ADD COLUMN IF NOT EXISTS prodamus_payment_url_6mo TEXT;    -- ссылка оплаты Продамус (6 мес)

-- ───────────────────────────────────────────────────────────────────────────
-- 4) Описания фич + контент модулей (тексты Марго, правятся потом в админке).
-- ───────────────────────────────────────────────────────────────────────────

-- Базовые фичи (входят в тарифы) — короткие описания для лендинга.
UPDATE features SET description = 'Готовые воронки привлечения зрителей через чат-бот и Мини-апп, реферальная система за подарки, требования подписки за регистрацию.'
 WHERE slug = 'lead_magnets';
UPDATE features SET description = 'Подключение своих ботов и каналов Telegram / MAX / ВКонтакте к рассылкам.'
 WHERE slug = 'channels';
UPDATE features SET description = 'Выгрузка контактной базы в CSV.'
 WHERE slug = 'export_contacts';

-- Модуль: Коллабораторная (Хаб).
UPDATE features SET
    is_addon = TRUE, price_monthly = 2000, price_6mo = 1600, min_tariff_slug = 'pro',
    name = 'Коллабораторная',
    tagline = 'Совместные события и общий хаб партнёров',
    description = 'Расширение над мероприятиями: объединяйте усилия с партнёрами в общем хабе совместных событий.',
    bullet_points = '[
      "Общий хаб совместных событий с партнёрами",
      "Распределение участников и подарков между организаторами",
      "Единая база контактов и аналитика по коллаборации"
    ]'::jsonb
 WHERE slug = 'collab_hub';

-- Модуль: Конференции.
UPDATE features SET
    is_addon = TRUE, price_monthly = 3000, price_6mo = 2400, min_tariff_slug = 'pro',
    name = 'Конференции',
    tagline = 'Всё для конференции в одном месте',
    description = 'Спикеры, программа, партнёры, участники, рассылки и розыгрыши — единый модуль для конференции.',
    bullet_points = '[
      "Всё в одном месте: афиши, тексты анонсов, спикеры, партнёры, участники",
      "Автоматизация работы со спикерами и партнёрами",
      "Личный кабинет спикера: фото, регалии, темы выступлений, рекламные материалы",
      "Автообновление инфо о спикерах в программе, лендинге и боте при изменении данных",
      "API для сторонних лендингов",
      "Готовые шаблоны рассылок с информацией о спикерах и выступлениях",
      "Розыгрыш призов"
    ]'::jsonb
 WHERE slug = 'conference';

-- Модуль: Премии / Турниры.
UPDATE features SET
    is_addon = TRUE, price_monthly = 5000, price_6mo = 4000, min_tariff_slug = 'pro',
    name = 'Премии и Турниры',
    tagline = 'Жюри, турнирные таблицы, оценка участников',
    description = 'Всё из модуля Конференции + жюри, динамические турнирные таблицы и автоотслеживание заданий в чатах.',
    bullet_points = '[
      "Всё в одном месте: спикеры, партнёры, участники, рассылки",
      "Автоматизация работы со спикерами и их личный кабинет",
      "Автообновление инфо о спикерах в программе, лендинге и боте",
      "API для сторонних лендингов",
      "Готовые шаблоны рассылок с информацией о спикерах",
      "Добавление жюри и их личных кабинетов",
      "Турнирные таблицы: динамическая настройка критериев",
      "Автоматическое отслеживание выкладки заданий участниками в чатах"
    ]'::jsonb
 WHERE slug = 'tournaments';

-- awards и event_tariffs — фичи без отдельной продажи (event_tariffs только в admin).
UPDATE features SET is_addon = FALSE WHERE slug IN ('awards', 'event_tariffs', 'contests');

-- ───────────────────────────────────────────────────────────────────────────
-- 5) Таблица client_addons — купленный модуль на конкретном клиенте.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_addons (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
    feature_id  INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'expired', 'cancelled')),
    source      TEXT NOT NULL DEFAULT 'paid'
                CHECK (source IN ('paid', 'admin', 'promo', 'trial')),
    price       INTEGER,
    months      INTEGER NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Один активный аддон на (клиент, фича). Продление = UPDATE expires_at, не дубль.
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_addon_active
    ON client_addons (client_id, feature_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_client_addons_client ON client_addons (client_id, expires_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 6) Заказы на аддоны через Продамус (зеркало subscription_orders).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS addon_orders (
    id                    SERIAL PRIMARY KEY,
    client_id             INTEGER NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
    feature_id            INTEGER NOT NULL REFERENCES features(id),
    months                INTEGER NOT NULL DEFAULT 1,
    amount_total_kopecks  INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'created'
                          CHECK (status IN ('created', 'paid', 'failed', 'cancelled')),
    prodamus_order_num    TEXT,
    prodamus_payment_type TEXT,
    prodamus_raw          JSONB,
    paid_at               TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_addon_orders_client ON addon_orders (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_addon_orders_status ON addon_orders (status, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 7) GRANT на роль plusson.
-- ───────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON client_addons, addon_orders TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_addons_id_seq, addon_orders_id_seq TO plusson;
