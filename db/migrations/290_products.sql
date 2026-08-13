-- 290: Продукты/услуги вне событий (2026-08-13)
--
-- Зачем. Уход с GetCourse. Клиенту нужно продавать то, что не является
-- событием: программа наставничества, мастер-класс, консультация,
-- «выступление спикером». У каждого свой лендинг, свои тарифы, приём оплаты
-- и материалы, которые человек получает после покупки.
--
-- Существующие сущности не подходят и НЕ трогаются:
--   lead_magnets      — файл за подписку, без продающей страницы и без оплаты;
--   client_offerings  — карточки в Экосистеме Mini App, без страницы и без денег;
--   лендинг события   — жёстко привязан к event_id.
--
-- ⚠️ Ключевое решение владельца: «материалы» и «курс» — ОДНА сущность.
-- Мастер-класс с одним файлом и программа из двадцати материалов различаются
-- только объёмом. Отдельного «тренинга» не заводим. Прогресса, открытия по
-- расписанию и домашек в этой версии НЕТ (sort_order заложен — надстроится потом).
--
-- ⚠️ Библиотека материалов ОБЩАЯ на кабинет: материал живёт в одном месте и
-- подключается в несколько продуктов, правка расходится везде. Копирование —
-- осознанное действие клиента («Взять копией»), а не механизм по умолчанию:
-- из разошедшихся копий обратно один материал уже не собрать.
--
-- Гейт на старте — фича `products` ТОЛЬКО у тарифа admin. Перенос в
-- продаваемый тариф потом, данными, без правок кода.

BEGIN;

-- ── Продукт ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

    -- Адрес лендинга: {домен клиента}/pr/{slug}
    slug        TEXT    NOT NULL,

    title       TEXT    NOT NULL,
    subtitle    TEXT,
    description TEXT,
    -- Обложка для карточки в кабинете купившего и в блоке «Мои продукты»
    cover_url   TEXT,

    -- ⚠️ Оферта СВОЯ у каждого продукта: она описывает конкретную услугу, её
    -- состав, цену и порядок возврата. Одна общая на наставничество и разовую
    -- консультацию юридически бессмысленна. Без неё лендинг не публикуется
    -- (проверка в API, не в БД: черновик без оферты — нормальное состояние).
    offer_url   TEXT,

    status      TEXT    NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'archived')),

    -- ── Словарь формулировок ──
    -- ⚠️ У части клиентов информационно-консультационные услуги: слова «урок»,
    -- «программа обучения», «домашнее задание», «ученик» не должны появляться
    -- НИГДЕ — ни на лендинге, ни в кабинете, ни в письмах, ни в сообщениях
    -- бота. Одно «Урок 3 открыт» в автоматическом письме сводит на нет
    -- аккуратные формулировки на витрине.
    --
    -- Дефолт `consulting` — он безопаснее: тому, кому нужны «уроки», проще их
    -- включить, чем тому, кому они противопоказаны, — заметить и убрать.
    wording_preset TEXT NOT NULL DEFAULT 'consulting'
                CHECK (wording_preset IN ('consulting', 'education')),
    -- Переопределения отдельных слов поверх пресета: {"unit": "Модуль", ...}
    wording     JSONB   NOT NULL DEFAULT '{}'::JSONB,

    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Адрес уникален в пределах кабинета: продукты живут на домене клиента,
    -- у разных клиентов /pr/mentoring могут спокойно сосуществовать.
    UNIQUE (client_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_products_client
    ON products(client_id, sort_order, id);

COMMENT ON TABLE  products IS 'Продукты/услуги вне событий: наставничество, мастер-класс, консультация';
COMMENT ON COLUMN products.wording_preset IS 'Словарь формулировок: consulting (дефолт) | education';
COMMENT ON COLUMN products.offer_url IS 'Оферта продукта. Обязательна перед публикацией (проверка в API)';

-- ── Тарифы продукта ───────────────────────────────────────────────────────
-- Зеркало event_tariffs: те же поля, та же семантика. Платёжный слой
-- (client_payments.create_payment_link) не знает ни про события, ни про
-- продукты — принимает клиента, номер заказа и цену, поэтому переиспользуется
-- как есть.
CREATE TABLE IF NOT EXISTS product_tariffs (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,

    -- Стабильный идентификатор тарифа (lowercase), используется в интеграциях
    code        TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    description TEXT,                       -- что входит
    excluded_description TEXT,              -- что НЕ входит

    -- Цена в рублях. NULL или 0 = бесплатный тариф: заказ не создаётся,
    -- доступ выдаётся сразу после формы (правило скопировано у событий).
    price       INTEGER,

    -- Фолбэк, когда платёжная система клиента не настроена: внешняя ссылка,
    -- оплата отмечается вручную. Снимает блокирующую зависимость от интеграции.
    pay_url     TEXT,
    -- Код товара в платёжной системе. Нужен ТОЛЬКО LeadPay: у Продамуса и
    -- Т-Банка название и цена уходят прямо в запросе.
    pay_product_id TEXT,

    order_hint  TEXT,                       -- подпись под кнопкой заказа
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,   -- выделенный тариф на лендинге

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (product_id, code)
);
CREATE INDEX IF NOT EXISTS idx_product_tariffs_product
    ON product_tariffs(product_id, sort_order, id);

-- ── Библиотека материалов (общая на кабинет) ──────────────────────────────
-- ⚠️ Материал НЕ принадлежит продукту. Он лежит в библиотеке клиента и
-- подключается в сколько угодно продуктов через product_materials. Правка
-- расходится везде — тот же принцип, что у живых блоков лендинга события
-- («не хранят копию контента»).
CREATE TABLE IF NOT EXISTS materials (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

    kind        TEXT    NOT NULL DEFAULT 'file'
                CHECK (kind IN ('video', 'file', 'link', 'text')),

    title       TEXT    NOT NULL,
    description TEXT,

    -- Файл в R2 / внешняя ссылка / ссылка на видео. Пусто только у kind='text'.
    url         TEXT,
    -- Тело для kind='text' (HTML из редактора)
    body        TEXT,

    duration_sec INTEGER,                   -- у видео: подпись «12 мин»
    size_bytes   BIGINT,                    -- у файла: подпись «4,2 МБ»

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_materials_client
    ON materials(client_id, id DESC);

COMMENT ON TABLE materials IS 'Общая библиотека материалов кабинета: один материал — много продуктов';

-- ── Состав продукта: продукт ↔ материал ───────────────────────────────────
CREATE TABLE IF NOT EXISTS product_materials (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,

    -- ⚠️ RESTRICT, не CASCADE: материал, который используется, молча удалить
    -- нельзя — у купивших отвалится доступ. Сначала отвязать от продуктов,
    -- интерфейс показывает «используется в: …».
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE RESTRICT,

    -- ⚠️ Название и порядок живут в СВЯЗКЕ, а не в материале. Один и тот же
    -- материал в курсе третий и называется «Урок 3. Возражения», а в
    -- мастер-классе первый и «Бонус: работа с возражениями». Положи это в
    -- материал — переименование в одном продукте поедет во все остальные.
    title_override TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,

    -- С какого тарифа материал открыт. NULL = открыт на всех тарифах продукта.
    min_tariff_id INTEGER REFERENCES product_tariffs(id) ON DELETE SET NULL,

    -- Показывать ли в блоке «Что входит» на лендинге. Не всё стоит светить:
    -- служебные файлы, бонусы-сюрпризы, техническая инструкция.
    show_on_landing BOOLEAN NOT NULL DEFAULT TRUE,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (product_id, material_id)
);
CREATE INDEX IF NOT EXISTS idx_product_materials_product
    ON product_materials(product_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_product_materials_material
    ON product_materials(material_id);

-- ── Заказы ────────────────────────────────────────────────────────────────
-- Зеркало event_participant_tariffs, но опирается на contact_id напрямую:
-- у продукта нет «участника события».
--
-- ⚠️ Номер заказа уходит в платёжку с префиксом `prd-<id>` (у событий `evt-`).
-- По префиксу вебхук отличает оплату продукта от оплаты тарифа события и от
-- оплаты подписки на саму платформу.
CREATE TABLE IF NOT EXISTS product_orders (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    tariff_id   INTEGER NOT NULL REFERENCES product_tariffs(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,

    status      TEXT    NOT NULL DEFAULT 'unpaid'
                CHECK (status IN ('unpaid', 'paid')),

    ordered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at     TIMESTAMPTZ,
    amount      NUMERIC(12, 2),

    source      TEXT,                       -- landing|leadpay|prodamus|tbank|manual
    external_payment_id TEXT,
    payment_url TEXT,
    payment_provider TEXT,

    note        TEXT,                       -- заметка организатора

    -- Идемпотентность: повторный вебхук (норма для платёжек) не плодит заказы.
    UNIQUE (contact_id, tariff_id)
);
CREATE INDEX IF NOT EXISTS idx_product_orders_product
    ON product_orders(product_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_product_orders_contact
    ON product_orders(contact_id);

-- ── Доступ: кто что купил ─────────────────────────────────────────────────
-- ⚠️ Отдельно от заказов намеренно. Доступ можно выдать руками — подарок,
-- бартер, перенос базы из GetCourse — без заказа и без денег. И наоборот:
-- заказ может остаться unpaid навсегда. Смешивать «человек заплатил» и
-- «человеку открыто» нельзя: это разные факты.
CREATE TABLE IF NOT EXISTS product_access (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

    -- По какому тарифу открыт — от него зависит, какие материалы видны.
    tariff_id   INTEGER REFERENCES product_tariffs(id) ON DELETE SET NULL,

    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source      TEXT NOT NULL DEFAULT 'order'
                CHECK (source IN ('order', 'manual')),
    order_id    INTEGER REFERENCES product_orders(id) ON DELETE SET NULL,

    UNIQUE (product_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_product_access_contact
    ON product_access(contact_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_product_access_product
    ON product_access(product_id, id DESC);

-- ⚠️ Роль plusson не владелец таблиц — без грантов API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON
    products, product_tariffs, materials, product_materials,
    product_orders, product_access TO plusson;
GRANT USAGE, SELECT ON
    products_id_seq, product_tariffs_id_seq, materials_id_seq,
    product_materials_id_seq, product_orders_id_seq, product_access_id_seq TO plusson;

-- ── Фича: пока ТОЛЬКО admin ───────────────────────────────────────────────
-- Раздел скрыт от клиентов до решения владельца. Перенос в продаваемый тариф —
-- одна строка в tariff_features, без правок кода.
INSERT INTO features (slug, name, description, sort)
VALUES ('products', 'Продукты/услуги',
        'Продукты вне событий: лендинг, тарифы с оплатой, материалы и кабинет купившего',
        97)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'products'
ON CONFLICT DO NOTHING;

COMMIT;
