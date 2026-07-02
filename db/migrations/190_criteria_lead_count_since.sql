-- 190: Дата начала отсчёта лидов для турнирного критерия auto_kind='lead_magnet'.
--
-- Критерий «Пришло в лид-магнит» считает COUNT(funnel_runs) по лид-магниту/пакету
-- спикера. Без даты старый лид-магнит с уже накопленными лидами даёт фору.
-- lead_count_since — считать только funnel_runs.landed_at >= этой даты.
-- NULL (default) — считать все (текущее поведение, не ломает существующие).

ALTER TABLE tournament_criteria
  ADD COLUMN IF NOT EXISTS lead_count_since TIMESTAMPTZ NULL;
