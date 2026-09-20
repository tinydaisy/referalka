-- 481: Опция «Показывать участнику, от кого он пришёл»
-- Галочка на уровне события (вкладка «Реф-программа»). Если TRUE — в разделе
-- «Подарки» участник видит строку «Вы пришли от спикера: Имя Фамилия» (или
-- «Вы пришли от: Имя», если привёл не спикер, а обычный участник).
-- Нужна конкурсам между спикерами: зритель должен понимать, в чьей он команде.
-- Показываем только когда реферер записан — пришедшим напрямую строки нет.

ALTER TABLE event_referral_settings
  ADD COLUMN IF NOT EXISTS show_referrer BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN event_referral_settings.show_referrer IS
  'Показывать участнику в «Подарках», кто его привёл (имя реферера)';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_referral_settings TO plusson;
