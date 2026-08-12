-- 284: Дашборд аналитики — квадратики-разрезы (2026-08-12)
--
-- Зачем. Клиент хочет видеть срезы базы: «сколько людей выбрали такой-то
-- вариант» — и, главное, ПЕРЕСЕКАТЬ их: «а кто с доходом больше 200 тысяч
-- идёт работать с наставником».
--
-- ⚠️ Ключевое: разрез бывает ДВУХ происхождений, и оба нужны.
--   1. Поле контакта  (contact_fields)   → значения в contact_field_values
--   2. Вопрос анкеты  (survey_questions) → значения в survey_answers
-- У клиента 1 на проде у ВСЕХ вопросов анкет field_id IS NULL — то есть
-- «Рассматривает наставника» физически НЕ лежит в contact_field_values.
-- Считать только по contact_fields значило бы потерять ровно то, что клиент
-- и просил пересекать. Оба источника сводятся к contact_id, поэтому
-- пересекаются свободно.
--
-- Отдельной «сущности сегмента» не заводим: условие — это тот же разрез,
-- только применённый как фильтр.

-- ── Дашборд: набор квадратиков ────────────────────────────────────────────
-- ⚠️ Дашбордов МНОГО (решение владельца): «Портрет базы», «Кто готов
-- покупать», «Спикеры» — разные вопросы к одной базе, каждому свой набор
-- квадратиков. Поэтому никаких UNIQUE на (client_id) — их тут быть не должно.
--
-- Общий (event_id IS NULL) — раздел «Аналитика».
-- Событийный (event_id = N) — карточка события → «Отслеживания».
-- Движок ОДИН; у событийного ко всем квадратикам молча добавляется условие
-- «контакт — участник этого события».
CREATE TABLE IF NOT EXISTS analytics_dashboards (
    id         SERIAL PRIMARY KEY,
    client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    event_id   INTEGER REFERENCES events(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL DEFAULT 'Дашборд',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Списки дашбордов: общие клиента и дашборды события — разные выборки.
CREATE INDEX IF NOT EXISTS idx_analytics_dash_client
    ON analytics_dashboards(client_id, sort_order, id) WHERE event_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_dash_event
    ON analytics_dashboards(event_id, sort_order, id) WHERE event_id IS NOT NULL;

-- ── Квадратик ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_cards (
    id           SERIAL PRIMARY KEY,
    dashboard_id INTEGER NOT NULL REFERENCES analytics_dashboards(id) ON DELETE CASCADE,

    -- Заголовок. Пусто → берём название поля/вопроса (клиенту не надо
    -- придумывать имя каждому автосозданному квадратику).
    title        TEXT,

    -- ⚠️ Разрез. source задаёт, ГДЕ искать значения:
    --   'field'    → contact_fields.id     → contact_field_values
    --   'question' → survey_questions.id   → survey_answers
    -- ref_id намеренно БЕЗ внешнего ключа: FK может смотреть только в одну
    -- таблицу, а источника два. Целостность держим кодом — удалённый разрез
    -- отдаётся как «источник удалён», карточка не ломает весь дашборд.
    source       TEXT NOT NULL DEFAULT 'field'
                 CHECK (source IN ('field','question')),
    ref_id       INTEGER NOT NULL,

    -- Условия-фильтры: дерево с И/ИЛИ и группами (решение владельца).
    -- Формат: {"op":"and","items":[
    --            {"source":"field","ref_id":3,"operator":"in","values":[...]},
    --            {"op":"or","items":[...]}
    --         ]}
    -- Пустой объект = без условий. Хранится JSONB, а не отдельными строками:
    -- вложенность произвольной глубины строками разложить нельзя, а читаем
    -- мы дерево всегда целиком.
    filters      JSONB NOT NULL DEFAULT '{}'::JSONB,

    -- Галочки показа (обе выключены → останутся только полоски).
    hide_absolute BOOLEAN NOT NULL DEFAULT FALSE,
    hide_percent  BOOLEAN NOT NULL DEFAULT FALSE,

    -- Порядок перетаскиванием. Шаг 10 — чтобы можно было вставить между.
    sort_order   INTEGER NOT NULL DEFAULT 0,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_cards_dash
    ON analytics_cards(dashboard_id, sort_order, id);

-- ⚠️ Роль plusson не владелец таблиц — без грантов API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_dashboards, analytics_cards TO plusson;
GRANT USAGE, SELECT ON
    analytics_dashboards_id_seq, analytics_cards_id_seq TO plusson;

-- ── Фича: Экстра (vip) и admin ────────────────────────────────────────────
INSERT INTO features (slug, name, description, sort)
VALUES ('analytics_dashboard', 'Дашборды аналитики',
        'Свои срезы базы квадратиками: разрез по полю или вопросу анкеты с пересечением условий',
        96)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE t.slug IN ('vip', 'admin') AND f.slug = 'analytics_dashboard'
ON CONFLICT DO NOTHING;
