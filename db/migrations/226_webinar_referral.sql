-- 226. Вебинар: реферальная регистрация — кто кого привёл на вебинар.
--
-- ЗАЧЕМ. Каждый (спикер/участник) зовёт людей на вебинар по своей реф-ссылке
-- pluson.ru/webinar/{slug}/{day}?pid={ref_code}. Нужно видеть отчёт «кто сколько
-- привёл на вебинар» — даже если приведённые НЕ в боте (обычный браузер, форма).
-- Заслуга = человек пришёл по реф-ссылке и ЗАРЕГИСТРИРОВАЛСЯ (форма/опознан).

BEGIN;

-- реф-код рефовода, по чьей ссылке человек пришёл на этот вебинар
ALTER TABLE webinar_registrations
  ADD COLUMN IF NOT EXISTS referrer_ref_code TEXT;

CREATE INDEX IF NOT EXISTS idx_webinar_reg_referrer
  ON webinar_registrations(room_id, referrer_ref_code);

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_registrations TO plusson;

COMMIT;
