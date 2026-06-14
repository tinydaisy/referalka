-- 139: Фиксация оценок жюри — на уровне КАЖДОГО участника (а не всего этапа).
-- Жюри может зафиксировать одного участника утром, другого вечером.
-- Добавляем subject_kind/subject_id; lock = (жюри × участник × этап).

ALTER TABLE tournament_jury_locks
    ADD COLUMN IF NOT EXISTS subject_kind TEXT,
    ADD COLUMN IF NOT EXISTS subject_id   BIGINT;

-- Старые UNIQUE-индексы (по жюри×этап) больше не нужны — фиксация теперь по участнику.
DROP INDEX IF EXISTS tournament_jury_locks_stage_uniq;
DROP INDEX IF EXISTS tournament_jury_locks_nostage_uniq;

-- Новые частичные UNIQUE: один lock на (жюри, участник, этап).
CREATE UNIQUE INDEX IF NOT EXISTS tjl_subj_stage_uniq
    ON tournament_jury_locks (juror_ec_id, subject_kind, subject_id, stage_id)
    WHERE stage_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tjl_subj_nostage_uniq
    ON tournament_jury_locks (juror_ec_id, subject_kind, subject_id)
    WHERE stage_id IS NULL;
