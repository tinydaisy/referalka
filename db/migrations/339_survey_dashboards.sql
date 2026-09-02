-- 339: дашборды анкеты + показ колонками (2026-09-02)
--
-- Зачем. Дашборд умеет считать разрезы по вопросам анкеты, но список
-- дашбордов был привязан либо к клиенту целиком, либо к событию. Открыть
-- «дашборды вот этой анкеты» было негде, а среди общих они терялись.
--
-- ⚠️ Это ОДНО хранилище с двумя входами, а не две сущности (решение
-- владельца): дашборд, созданный из анкеты, виден и в разделе «Аналитика»;
-- созданный в «Аналитике» с выбором анкеты — виден внутри этой анкеты.
-- Поэтому не новая таблица, а колонка привязки — рядом с event_id.

ALTER TABLE analytics_dashboards
    ADD COLUMN IF NOT EXISTS survey_id INTEGER REFERENCES surveys(id) ON DELETE CASCADE;

COMMENT ON COLUMN analytics_dashboards.survey_id IS
  'Дашборд конкретной анкеты. NULL — общий или событийный. Виден в обоих местах.';

-- Список дашбордов анкеты.
CREATE INDEX IF NOT EXISTS idx_analytics_dash_survey
    ON analytics_dashboards(survey_id, sort_order, id) WHERE survey_id IS NOT NULL;

-- ── Вид показа: плитками или колонками ────────────────────────────────────
-- 'cards'   — как было: сетка квадратиков.
-- 'columns' — колонки: в шапке цифра, внутри прокручиваемый список людей.
--             Список сворачивается до шапки — иначе на телефоне до соседней
--             колонки пришлось бы прокручивать сотни строк.
ALTER TABLE analytics_dashboards
    ADD COLUMN IF NOT EXISTS layout TEXT NOT NULL DEFAULT 'cards';

DO $$
BEGIN
    ALTER TABLE analytics_dashboards
        ADD CONSTRAINT analytics_dashboards_layout_chk
        CHECK (layout IN ('cards', 'columns'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN analytics_dashboards.layout IS
  'Вид показа: cards — плитками, columns — колонками со списком людей внутри.';

-- ── Дашборд «Обработка заявок» каждой анкете ──────────────────────────────
-- ⚠️ Заводим и существующим анкетам, а не только новым: смысл раздела в том,
-- чтобы разбирать УЖЕ накопленные заявки (на проде их полторы сотни).
--
-- Плитками на каждый вариант («Да» и «Нет»), а не одной карточкой-списком:
-- владельцу нужна цифра «сколько осталось разобрать», а не полоска.
WITH new_dash AS (
    INSERT INTO analytics_dashboards (client_id, survey_id, title, sort_order)
    SELECT s.client_id, s.id, 'Обработка заявок', 0
      FROM surveys s
     WHERE NOT EXISTS (
         SELECT 1 FROM analytics_dashboards d WHERE d.survey_id = s.id
     )
    RETURNING id, survey_id
)
INSERT INTO analytics_cards (dashboard_id, source, ref_id, survey_id, view, option_value, sort_order)
SELECT d.id, 'question', q.id, d.survey_id, 'tile', v.opt, v.ord
  FROM new_dash d
  JOIN survey_questions q
    ON q.survey_id = d.survey_id AND q.is_protected AND q.filled_by = 'staff'
  CROSS JOIN (VALUES ('Да', 0), ('Нет', 10)) AS v(opt, ord);
