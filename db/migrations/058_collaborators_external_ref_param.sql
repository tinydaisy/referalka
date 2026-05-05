-- 058: внешний партнёрский параметр на коллабораторе
-- Опаковая строка вида "gcpc=fdd97" / "partner_id=abc123" / "ref=xyz",
-- которую клиент копирует из внешней платформы (GetCourse, Bizon360 и т.п.)
-- и которую мы будем приписывать к URL стороннего лендинга через ? или &.
-- Не парсим, не валидируем — клиенту виднее.

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS external_ref_param TEXT;

COMMENT ON COLUMN collaborators.external_ref_param IS
  'Партнёрский параметр для внешних платформ (например, "gcpc=fdd97"). Опаковая строка key=value, приписывается к URL стороннего лендинга. NULL — параметр не приписывается.';
