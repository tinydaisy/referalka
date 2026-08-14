-- Категории продуктов — раскладка кабинета по проектам (2026-08-14).
--
-- Зачем. Продуктов у клиента уже больше десятка, и все они лежат одним
-- списком: «Коммерческое предложение для спикеров», «Фокусировка», «Крео
-- СПРИНТ» — вперемешку, хотя относятся к РАЗНЫМ направлениям бизнеса.
-- Владелец мыслит проектами: организация конференций, финансовое
-- планирование, продажи и маркетинг. Категория даёт ровно эту раскладку.
--
-- ⚠️ Это ВНУТРЕННЯЯ раскладка кабинета, а не витрина: у продуктов нет
-- публичного каталога (см. products_public.py). Поэтому ни в каких
-- публичных ответах категория не участвует — она про удобство работы.
--
-- ⚠️ Категория НЕОБЯЗАТЕЛЬНА (nullable). Продукт без категории попадает в
-- «Без категории» — заводя новый продукт, человек не обязан сразу решать,
-- куда его отнести.

CREATE TABLE IF NOT EXISTS product_categories (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_categories_client
    ON product_categories (client_id, sort_order, id);

-- ⚠️ ON DELETE SET NULL, а не CASCADE: удаление категории — это про
-- раскладку, а не про товар. Каскад унёс бы вместе с папкой сами продукты
-- со всеми заказами и доступами покупателей.
ALTER TABLE products
    ADD COLUMN IF NOT EXISTS category_id INTEGER
        REFERENCES product_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_category ON products (category_id);

-- Роль plusson не владелец таблиц — без GRANT кабинет получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories TO plusson;
GRANT USAGE, SELECT ON SEQUENCE product_categories_id_seq TO plusson;
