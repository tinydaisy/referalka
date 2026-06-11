-- Миграция 133 (2026-06-11) — оцениваемые в турнире = участники И спикеры.
--
-- В миграции 132 оцениваемый (subject) жёстко = event_collaborators.id (только спикеры).
-- По ТЗ оценивать нужно ВСЕХ зарегистрированных участников (event_participants)
-- + коллабораторов-спикеров. Вводим составной идентификатор:
--   subject_kind ∈ 'ec' (event_collaborators.id) | 'ep' (event_participants.id)
--   subject_id   — id в соответствующей таблице.
--
-- Жюри по-прежнему всегда коллаборатор (juror_ec_id = event_collaborators.id).
--
-- FK на subject убираем (он теперь полиморфный — ссылается на две таблицы).
-- Целостность поддерживаем в коде. Старые строки (если были) = 'ec'.

-- ───────────── tournament_scores ─────────────
-- старая колонка subject_ec_id теперь легаси (пишем в subject_kind/subject_id) — снять NOT NULL
ALTER TABLE tournament_scores            ALTER COLUMN subject_ec_id DROP NOT NULL;
ALTER TABLE tournament_jury_assignments  ALTER COLUMN subject_ec_id DROP NOT NULL;
ALTER TABLE tournament_feedback          ALTER COLUMN subject_ec_id DROP NOT NULL;

ALTER TABLE tournament_scores
    ADD COLUMN IF NOT EXISTS subject_kind TEXT NOT NULL DEFAULT 'ec'
    CHECK (subject_kind IN ('ec', 'ep'));
ALTER TABLE tournament_scores
    ADD COLUMN IF NOT EXISTS subject_id BIGINT;
-- бэкфилл из старой колонки subject_ec_id
UPDATE tournament_scores SET subject_id = subject_ec_id WHERE subject_id IS NULL;
-- снять старый FK на subject_ec_id (имя сгенерировано автоматически — ищем и дропаем)
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'tournament_scores'::regclass AND contype='f'
      AND pg_get_constraintdef(oid) LIKE '%subject_ec_id%'
  LOOP EXECUTE 'ALTER TABLE tournament_scores DROP CONSTRAINT ' || quote_ident(c); END LOOP;
END $$;
-- пересоздать частичные UNIQUE с учётом subject_kind/subject_id
DROP INDEX IF EXISTS uq_tournament_scores_jury;
DROP INDEX IF EXISTS uq_tournament_scores_nonjury;
CREATE UNIQUE INDEX uq_tournament_scores_jury
    ON tournament_scores (criterion_id, subject_kind, subject_id, juror_ec_id)
    WHERE juror_ec_id IS NOT NULL;
CREATE UNIQUE INDEX uq_tournament_scores_nonjury
    ON tournament_scores (criterion_id, subject_kind, subject_id)
    WHERE juror_ec_id IS NULL;

-- ───────────── tournament_jury_assignments ─────────────
ALTER TABLE tournament_jury_assignments
    ADD COLUMN IF NOT EXISTS subject_kind TEXT NOT NULL DEFAULT 'ec'
    CHECK (subject_kind IN ('ec', 'ep'));
ALTER TABLE tournament_jury_assignments
    ADD COLUMN IF NOT EXISTS subject_id BIGINT;
UPDATE tournament_jury_assignments SET subject_id = subject_ec_id WHERE subject_id IS NULL;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'tournament_jury_assignments'::regclass AND contype IN ('f','u')
      AND pg_get_constraintdef(oid) LIKE '%subject_ec_id%'
  LOOP EXECUTE 'ALTER TABLE tournament_jury_assignments DROP CONSTRAINT ' || quote_ident(c); END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_assignment
    ON tournament_jury_assignments (juror_ec_id, subject_kind, subject_id);

-- ───────────── tournament_feedback ─────────────
ALTER TABLE tournament_feedback
    ADD COLUMN IF NOT EXISTS subject_kind TEXT NOT NULL DEFAULT 'ec'
    CHECK (subject_kind IN ('ec', 'ep'));
ALTER TABLE tournament_feedback
    ADD COLUMN IF NOT EXISTS subject_id BIGINT;
UPDATE tournament_feedback SET subject_id = subject_ec_id WHERE subject_id IS NULL;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'tournament_feedback'::regclass AND contype='f'
      AND pg_get_constraintdef(oid) LIKE '%subject_ec_id%'
  LOOP EXECUTE 'ALTER TABLE tournament_feedback DROP CONSTRAINT ' || quote_ident(c); END LOOP;
END $$;
DROP INDEX IF EXISTS uq_tournament_feedback_stage;
DROP INDEX IF EXISTS uq_tournament_feedback_nostage;
CREATE UNIQUE INDEX uq_tournament_feedback_stage
    ON tournament_feedback (juror_ec_id, subject_kind, subject_id, stage_id)
    WHERE stage_id IS NOT NULL;
CREATE UNIQUE INDEX uq_tournament_feedback_nostage
    ON tournament_feedback (juror_ec_id, subject_kind, subject_id)
    WHERE stage_id IS NULL;

-- ───────────── снимки: добавить subject_kind (для информации) ─────────────
ALTER TABLE tournament_snapshot_rows    ADD COLUMN IF NOT EXISTS subject_kind TEXT;
ALTER TABLE tournament_snapshot_scores  ADD COLUMN IF NOT EXISTS subject_kind TEXT;

COMMENT ON COLUMN tournament_scores.subject_kind IS 'ec=event_collaborators | ep=event_participants';

-- ───────────── этап теперь на уровне КРИТЕРИЯ (не пакета) ─────────────
-- По ТЗ: «на уровне критериев надо этапы задавать». Пакет остаётся смысловой
-- группой (название + вес + нормализация), этап выбирается у каждого критерия.
ALTER TABLE tournament_criteria
    ADD COLUMN IF NOT EXISTS stage_id BIGINT REFERENCES conf_stages(id) ON DELETE SET NULL;
-- бэкфилл: критерий наследует этап своего пакета (если у пакета он был задан)
UPDATE tournament_criteria c
   SET stage_id = p.stage_id
  FROM tournament_packages p
 WHERE p.id = c.package_id AND c.stage_id IS NULL AND p.stage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tournament_criteria_stage_idx ON tournament_criteria (stage_id);
