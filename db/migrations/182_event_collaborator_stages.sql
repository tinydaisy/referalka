-- 182: поимённая привязка спикера/жюри (event_collaborators) к этапам турнира.
-- Управляет видимостью человека в кабинете, распределении и турнирной таблице
-- НА КОНКРЕТНОМ ЭТАПЕ. Нет записей у человека → он не участвует ни в одном этапе.
CREATE TABLE IF NOT EXISTS event_collaborator_stages (
  id          SERIAL PRIMARY KEY,
  ec_id       INTEGER NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
  stage_id    INTEGER NOT NULL REFERENCES conf_stages(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ec_id, stage_id)
);
CREATE INDEX IF NOT EXISTS idx_ec_stages_ec ON event_collaborator_stages(ec_id);
CREATE INDEX IF NOT EXISTS idx_ec_stages_stage ON event_collaborator_stages(stage_id);
-- GRANT для роли plusson (если роль не postgres):
-- GRANT SELECT, INSERT, UPDATE, DELETE ON event_collaborator_stages TO plusson;
-- GRANT USAGE, SELECT ON event_collaborator_stages_id_seq TO plusson;
