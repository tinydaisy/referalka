-- 227. Турнирный критерий «Зрителей в вебинаре» — привязка к конкретному вебинару (дню).
--
-- ЗАЧЕМ. У события несколько вебинаров (по дням), у каждого своя реф-ссылка.
-- Критерий webinar_viewers должен считать зрителей ПО КОНКРЕТНОМУ вебинару (дню),
-- а не суммарно по всем. Если день не задан (NULL) — считаем по всем вебинарам события.

BEGIN;

ALTER TABLE tournament_criteria
  ADD COLUMN IF NOT EXISTS webinar_day INTEGER;

-- Разрешаем новый auto_kind='webinar_viewers' в CHECK-констрейнте.
ALTER TABLE tournament_criteria DROP CONSTRAINT IF EXISTS tournament_criteria_auto_kind_check;
ALTER TABLE tournament_criteria ADD CONSTRAINT tournament_criteria_auto_kind_check
  CHECK (auto_kind IS NULL OR auto_kind = ANY (ARRAY[
    'referrals'::text, 'lead_magnet'::text, 'replace'::text, 'sum'::text, 'webinar_viewers'::text]));

GRANT SELECT, INSERT, UPDATE, DELETE ON tournament_criteria TO plusson;

COMMIT;
