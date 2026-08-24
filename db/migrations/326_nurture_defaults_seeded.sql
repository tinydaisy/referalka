-- 326: отметка «дефолтные шаги догрева уже выдавались этому событию»
--
-- ЗАЧЕМ. Удаление шага догрева выглядело сломанным: клиент удалял шаг, DELETE
-- отрабатывал (в логах прода 200 OK), список перечитывался — и шаг появлялся
-- снова. Причина: GET списка сеял дефолты по условию «шагов нет», поэтому
-- удаление ПОСЛЕДНЕГО шага немедленно воскрешало все три.
--
-- Теперь условие сева — не «список пуст», а «дефолты этому событию ещё не
-- выдавали». Первый заход на новое событие по-прежнему получает готовые шаги;
-- удалённое остаётся удалённым.
--
-- Бэкфилл: у событий, где шаги уже есть, отметку ставим сразу — иначе после
-- их удаления дефолты высеялись бы повторно.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS nurture_defaults_seeded     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS nurture_reg_defaults_seeded BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE events e
   SET nurture_defaults_seeded = TRUE
 WHERE EXISTS (SELECT 1 FROM event_nurture_steps s WHERE s.event_id = e.id);

UPDATE events e
   SET nurture_reg_defaults_seeded = TRUE
 WHERE EXISTS (SELECT 1 FROM event_nurture_reg_steps s WHERE s.event_id = e.id);
