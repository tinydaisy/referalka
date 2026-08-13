-- 291: Разделы продукта — группировка материалов (2026-08-13)
--
-- Зачем. Состав продукта был плоским списком. Для мастер-класса из одного
-- файла это нормально, для программы наставничества на несколько недель —
-- нет: тридцать позиций подряд не читаются ни в кабинете клиента, ни на
-- лендинге.
--
-- Раздел — необязательный уровень между продуктом и материалом:
--   Продукт → [Раздел] → Материал
-- Материал без раздела (section_id IS NULL) показывается первым уровнем, как
-- и раньше. Продукт из трёх файлов разделов не заводит вовсе.
--
-- ⚠️ Как раздел НАЗЫВАЕТСЯ в интерфейсе — решает словарь продукта
-- (products.wording_preset): у образовательного «Модуль», у консультационного
-- «Блок». Слово в БД не хранится: клиент переключает пресет, и подпись
-- меняется везде разом — на странице, в кабинете, в письмах.
--
-- ⚠️ Прогресса и открытия по расписанию по-прежнему НЕТ. Раздел — это только
-- группировка. `sort_order` заложен, доступ по тарифу остаётся на материале.

BEGIN;

CREATE TABLE IF NOT EXISTS product_sections (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,

    -- ⚠️ Вложенность ЛЮБОЙ глубины: раздел может лежать внутри раздела.
    -- Клиент сам решает, нужен ему один уровень («Модуль 1»), два
    -- («Блок 1 → Неделя 2») или три. Ограничить глубину двумя уровнями было бы
    -- дешевле в интерфейсе, но снять это ограничение потом — уже миграция с
    -- бэкфиллом, а структуру продукта задают один раз.
    --
    -- CASCADE: удаляя раздел, клиент удаляет и вложенные в него разделы —
    -- иначе они осиротели бы и пропали из дерева, оставшись в базе.
    -- Материалы при этом НЕ теряются: у них section_id → SET NULL, они
    -- поднимаются на верхний уровень (см. ниже).
    parent_id   INTEGER REFERENCES product_sections(id) ON DELETE CASCADE,

    title       TEXT    NOT NULL,
    description TEXT,

    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_sections_product
    ON product_sections(product_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_product_sections_parent
    ON product_sections(parent_id, sort_order, id);

COMMENT ON TABLE product_sections IS
    'Разделы продукта: группировка материалов. Название («Модуль»/«Блок») задаёт словарь продукта';

-- Материал в составе может лежать в разделе.
-- ⚠️ SET NULL, не CASCADE: удаление раздела не должно уносить материалы из
-- продукта — они просто поднимутся на верхний уровень. Иначе клиент, убрав
-- «Модуль 2», молча лишил бы купивших доступа к его содержимому.
ALTER TABLE product_materials
    ADD COLUMN IF NOT EXISTS section_id INTEGER
        REFERENCES product_sections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_product_materials_section
    ON product_materials(section_id, sort_order, id);

COMMENT ON COLUMN product_materials.section_id IS
    'Раздел продукта. NULL = материал первого уровня (продукт без группировки)';

-- ⚠️ Роль plusson не владелец таблиц.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_sections TO plusson;
GRANT USAGE, SELECT ON product_sections_id_seq TO plusson;

COMMIT;
