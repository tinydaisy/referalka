-- 138: Фиксация оценок жюри по этапу.
-- Жюри/организатор нажимает «Зафиксировать результат» за этап — после этого
-- его оценки за этот этап править нельзя. Одна строка = (жюри × этап) зафиксирован.
-- stage_id NULL = фиксация «весь турнир» (когда у события нет этапов).

CREATE TABLE IF NOT EXISTS tournament_jury_locks (
    id          BIGSERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    juror_ec_id BIGINT  NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    stage_id    BIGINT  REFERENCES conf_stages(id) ON DELETE CASCADE,
    locked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Один lock на (жюри, этап). Частичные индексы: NULL-этап и конкретный этап.
CREATE UNIQUE INDEX IF NOT EXISTS tournament_jury_locks_stage_uniq
    ON tournament_jury_locks (event_id, juror_ec_id, stage_id)
    WHERE stage_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tournament_jury_locks_nostage_uniq
    ON tournament_jury_locks (event_id, juror_ec_id)
    WHERE stage_id IS NULL;
