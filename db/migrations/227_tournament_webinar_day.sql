-- 227. Турнирный критерий «Зрителей в вебинаре» — привязка к конкретному вебинару (дню).
--
-- ЗАЧЕМ. У события несколько вебинаров (по дням), у каждого своя реф-ссылка.
-- Критерий webinar_viewers должен считать зрителей ПО КОНКРЕТНОМУ вебинару (дню),
-- а не суммарно по всем. Если день не задан (NULL) — считаем по всем вебинарам события.

BEGIN;

ALTER TABLE tournament_criteria
  ADD COLUMN IF NOT EXISTS webinar_day INTEGER;

GRANT SELECT, INSERT, UPDATE, DELETE ON tournament_criteria TO plusson;

COMMIT;
