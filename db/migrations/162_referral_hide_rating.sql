-- 162: Опция «Отключить рейтинг (ТОП) в реф-кабинете участника»
-- Галочка на уровне события (вкладка «Реф-программа»). Если TRUE — блок
-- «🏆 ТОП рейтинг» не показывается ни в Mini App (GameTab), ни в веб-версии
-- кабинета участника (/event/{slug}?c=...). Подарки/ссылки/материалы — остаются.

ALTER TABLE event_referral_settings
  ADD COLUMN IF NOT EXISTS hide_rating BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_referral_settings TO plusson;
