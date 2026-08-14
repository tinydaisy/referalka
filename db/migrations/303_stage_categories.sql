-- 303_stage_categories.sql
-- 2026-08-14
--
-- КАТЕГОРИИ НОМИНАЦИЙ/ТУРОВ/ЭТАПОВ.
--
-- Зачем. В премии номинаций бывает 70. Плоским списком они нечитаемы —
-- нужен верхний уровень: «Медицина» → «Лучший хирург», «Медсестра года».
-- В турнире тот же механизм = секции/направления: внутри секции свои туры,
-- потом общие туры по отобранным.
--
-- ⚠️ КАТЕГОРИЯ, А НЕ ТЕГИ — решение владельца: «одна номинация в одной
--     категории, в настройках номинации указывать, к какой относится».
--     Теги (многие-ко-многим) разрешили бы номинации быть в двух категориях
--     сразу и не дали бы порядка сортировки. Здесь связь один-ко-многим.
--
-- ⚠️ conf_stages НЕ переименовываем в «номинации»: на эту таблицу завязаны
--     дни программы, критерии, распределение жюри, оценки, снимки отчётов.
--     Номинация/тур/этап — одна сущность, разное только слово в интерфейсе.
--
-- ⚠️ Ничего существующего не ломает: колонка nullable, старый код её
--     не читает (проверено — все SELECT по conf_stages либо `SELECT *`,
--     либо явный список колонок).

BEGIN;

CREATE TABLE IF NOT EXISTS conf_stage_categories (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    title       TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stage_categories_event
  ON conf_stage_categories (event_id, sort_order, id);

-- ON DELETE SET NULL: удалённая категория не должна уносить с собой
-- номинации вместе с их критериями, жюри и оценками.
ALTER TABLE conf_stages
  ADD COLUMN IF NOT EXISTS category_id INTEGER
    REFERENCES conf_stage_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conf_stages_category
  ON conf_stages (category_id);

COMMENT ON TABLE conf_stage_categories IS
  'Надкатегории номинаций/туров (миграция 303). Одна номинация — одна категория.';
COMMENT ON COLUMN conf_stages.category_id IS
  'Категория номинации. NULL = без категории (номинация сама по себе).';

-- ⚠️ Роль plusson не владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON conf_stage_categories TO plusson;
GRANT USAGE, SELECT ON SEQUENCE conf_stage_categories_id_seq TO plusson;

COMMIT;
