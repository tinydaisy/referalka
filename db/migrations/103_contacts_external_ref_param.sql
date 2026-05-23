-- 103: перенос external_ref_param с коллабораторов на контакты
-- Партнёром во внешней платформе клиента (GetCourse, Bizon360 и т.п.)
-- может быть любой контакт, не обязательно коллаборатор.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS external_ref_param TEXT;

COMMENT ON COLUMN contacts.external_ref_param IS
  'Партнёрский параметр контакта для внешних платформ (например, "gcpc=fdd97"). Опаковая строка key=value, приписывается к URL стороннего лендинга. NULL — параметр не приписывается.';

-- Перенос существующих значений с коллабораторов на их контакты.
UPDATE contacts c
   SET external_ref_param = col.external_ref_param
  FROM collaborators col
 WHERE col.contact_id = c.id
   AND col.external_ref_param IS NOT NULL
   AND col.external_ref_param <> ''
   AND (c.external_ref_param IS NULL OR c.external_ref_param = '');

ALTER TABLE collaborators
  DROP COLUMN IF EXISTS external_ref_param;
