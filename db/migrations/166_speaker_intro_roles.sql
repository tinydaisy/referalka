-- 166: выбор ролей для шаблона «Знакомство со спикерами» (speaker_intro).
-- Какие роли коллабораторов включать в рассылку знакомства.
-- NULL = все роли (поведение по умолчанию, как было). Массив = только эти роли.
-- Роли: 'speaker','headliner','jury','organizer','partner'.

ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS intro_roles TEXT[] DEFAULT NULL;
