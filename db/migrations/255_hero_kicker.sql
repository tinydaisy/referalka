-- 255: Подпись-«таблетка» рядом с датой в шапке лендинга (миграции 240-254).
--
-- Над заголовком идут два овала в один ряд: слева тип события
-- («Онлайн-конференция»), справа дата. Текст левого овала клиент вписывает
-- сам — тип события в базе не хранится в человекочитаемом виде
-- (module_slug = conference/turnir/contest), а формулировка на продающей
-- странице у каждого своя.
--
-- Пусто → показывается только овал с датой.

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS kicker TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
