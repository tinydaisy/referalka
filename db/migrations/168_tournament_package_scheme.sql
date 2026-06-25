-- 168: схема расчёта пакета турнира (4 схемы) вместо пары normalize+aggregate
-- Схемы:
--   s1 = «Сырая сумма ÷ лидера × 10»      (Σ(знач×вес) / сумма_лидера × 10) — вовлечение
--   s2 = «Доля от лучшего ÷ сумму весов»  (Σ(доля×вес) / Σвесов × 10)       — разномасштабные
--   s3 = «Среднее значений»               (Σ(знач×вес) / Σвесов)            — жюри (оценки уже 0..10)
--   s4 = «Чистая сумма»                   (Σ(знач×вес), без деления)        — задания (Этап 0)
--
-- Маппинг существующих пакетов (чтобы расчёт НЕ изменился):
--   aggregate='sum'              -> s4  (Этап 0: СИСТЕМНОСТЬ, Вовлечение)
--   normalize=t, aggregate='avg' -> s2
--   normalize=f, aggregate='avg' -> s3  (Этап 0: ДЕНЬГИ; жюри Чемпионата)
-- Поля normalize/aggregate ОСТАВЛЕНЫ для совместимости, расчёт идёт по scheme.

ALTER TABLE tournament_packages
  ADD COLUMN IF NOT EXISTS scheme TEXT NOT NULL DEFAULT 's3';

-- бэкфилл из текущих настроек — биться 1-в-1 со старым расчётом
UPDATE tournament_packages
   SET scheme = CASE
       WHEN aggregate = 'sum'                       THEN 's4'
       WHEN normalize = TRUE  AND aggregate = 'avg' THEN 's2'
       ELSE 's3'   -- normalize=f, aggregate='avg'
   END;

ALTER TABLE tournament_packages
  DROP CONSTRAINT IF EXISTS tournament_packages_scheme_check;
ALTER TABLE tournament_packages
  ADD CONSTRAINT tournament_packages_scheme_check
  CHECK (scheme IN ('s1','s2','s3','s4'));

-- Чемпионат (event 24): пакет «ВОВЛЕЧЕНИЕ» переводим на Схему 1 (÷ лидера),
-- пакет «Оценки жюри» — на Схему 3 (среднее). Идемпотентно по факту.
UPDATE tournament_packages SET scheme = 's1'
  WHERE event_id = 24 AND title = 'ВОВЛЕЧЕНИЕ' AND stage_id = 2;
UPDATE tournament_packages SET scheme = 's3'
  WHERE event_id = 24 AND title = 'Оценки жюри' AND stage_id = 2;

GRANT SELECT, INSERT, UPDATE, DELETE ON tournament_packages TO plusson;
