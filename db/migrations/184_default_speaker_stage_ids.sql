-- 184: этапы по умолчанию для новых спикеров турнира. Когда спикер
-- регистрируется сам (spkreg) или его добавляют из дашборда — он автоматически
-- привязывается к этим этапам (event_collaborator_stages). Только для турниров.
ALTER TABLE conf_conferences
  ADD COLUMN IF NOT EXISTS default_speaker_stage_ids INT[] DEFAULT '{}'::int[];
