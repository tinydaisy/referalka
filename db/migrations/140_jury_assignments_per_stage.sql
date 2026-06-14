-- 140: Распределение жюри↔участник — отдельно на КАЖДОМ этапе.
-- Добавляем stage_id; старые назначения (без этапа) удаляем (по решению: не мигрируем).
-- Жюри назначается на участника В РАМКАХ ЭТАПА.

ALTER TABLE tournament_jury_assignments
    ADD COLUMN IF NOT EXISTS stage_id BIGINT REFERENCES conf_stages(id) ON DELETE CASCADE;

-- Удаляем все прежние назначения (они общие на событие — больше не валидны).
DELETE FROM tournament_jury_assignments;

-- Старый UNIQUE (без этапа) заменяем на UNIQUE с этапом.
DROP INDEX IF EXISTS uq_tournament_assignment;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_assignment_stage
    ON tournament_jury_assignments (juror_ec_id, subject_kind, subject_id, stage_id)
    WHERE stage_id IS NOT NULL;
-- На случай событий без этапов — общий вариант (stage_id NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_assignment_nostage
    ON tournament_jury_assignments (juror_ec_id, subject_kind, subject_id)
    WHERE stage_id IS NULL;
