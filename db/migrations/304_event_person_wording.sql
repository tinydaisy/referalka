-- 304_event_person_wording.sql
-- 2026-08-15
--
-- СЛОВАРЬ: КАК НАЗЫВАТЬ УЧАСТНИКА СОБЫТИЯ.
--
-- Зачем. На конференции человек — «спикер», в премии — «номинант»,
-- в турнире — просто «участник». Слово всплывает в ДЕСЯТКАХ мест: карточка
-- роли в дашборде, вкладки, кабинет спикера, рассылки, публичные страницы.
--
-- ⚠️ Подменять слово точечно в UI НЕЛЬЗЯ — так уже начали делать и сразу
--    получили вразнобой: в карточке «номинант», а в рассылке тому же человеку
--    приходит «спикер». Поэтому источник один — это поле.
--
-- Значения (`events.person_wording`):
--   speaker  — Спикер   (дефолт, как было всегда)
--   nominee  — Номинант (премии)
--   member   — Участник (турниры, где не выступают)
--
-- ⚠️ Роль в БД (`event_collaborators.role='speaker'`) НЕ меняется — это
--    техническое значение, на нём завязаны сортировка, гейты и рассылки.
--    Здесь только ЧЕЛОВЕЧЕСКОЕ слово для показа.
--
-- ⚠️ Дефолт 'speaker' обязателен: без него у 40+ существующих событий поле
--    было бы NULL, и каждое место показа пришлось бы страховать COALESCE.

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS person_wording TEXT NOT NULL DEFAULT 'speaker';

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_person_wording_check;
ALTER TABLE events
  ADD CONSTRAINT events_person_wording_check
  CHECK (person_wording IN ('speaker', 'nominee', 'member'));

COMMENT ON COLUMN events.person_wording IS
  'Как называть участника: speaker|nominee|member (миграция 304). Только слово для показа, роль в event_collaborators не меняет.';

COMMIT;
