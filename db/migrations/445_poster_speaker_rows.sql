-- 445: порядок спикеров на афише хранится ПО РЯДАМ, а не плоским списком.
--
-- ⚠️ ЗАЧЕМ. Требование владельца (18.09.2026): «я сказала делать по рядам —
-- чтобы я могла перетащить спикера из ряда в ряд». Плоский список
-- (`speaker_order`, миграция 435) этого не умеет в принципе: он задаёт только
-- очерёдность, а на сколько рядов её порежет автоматика — решала сама
-- раскладка. Перетащишь человека «во второй ряд» — он уедет обратно, как
-- только пересчитается разбивка.
--
-- ⚠️ СКОЛЬКО ПОЛОЖИЛИ В РЯД — СТОЛЬКО И БУДЕТ. Ряды разной длины — это норма
-- и именно так верстают настоящие афиши: сверху двое хедлайнеров крупно, ниже
-- пятеро спикеров плотнее. Выравнивать ряды по одной длине нельзя: тогда
-- перетаскивание снова теряет смысл.
--
-- Формат: массив массивов id коллабораторов — [[12,7],[3,9,15,4]].
-- Пусто — раскладку считает автоматика (как раньше).
--
-- ⚠️ `speaker_order` НЕ УДАЛЯЕМ: он остаётся запасным порядком для случая,
-- когда ряды не заданы, и хранит уже сделанные клиентами расстановки. Читается
-- только если `speaker_rows` пуст.

BEGIN;

ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS speaker_rows JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE event_poster_layouts
  DROP CONSTRAINT IF EXISTS event_poster_layouts_rows_is_array;
ALTER TABLE event_poster_layouts
  ADD CONSTRAINT event_poster_layouts_rows_is_array
  CHECK (jsonb_typeof(speaker_rows) = 'array');

COMMENT ON COLUMN event_poster_layouts.speaker_rows IS
  'Спикеры по рядам: [[id,id],[id,id,id]]. Сколько положили в ряд — столько и будет. Пусто = автоматика';

COMMENT ON COLUMN event_poster_layouts.speaker_order IS
  'Плоский порядок (мигр. 435). Запасной: читается, только если speaker_rows пуст';

-- Порядок ЛОГОТИПОВ партнёров — тоже перетаскиванием.
-- ⚠️ Отдельно от спикеров: партнёры-компании идут строкой логотипов сверху и в
-- сетку людей не попадают вовсе, поэтому общий список их бы не описал.
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS partner_order JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE event_poster_layouts
  DROP CONSTRAINT IF EXISTS event_poster_layouts_partners_is_array;
ALTER TABLE event_poster_layouts
  ADD CONSTRAINT event_poster_layouts_partners_is_array
  CHECK (jsonb_typeof(partner_order) = 'array');

COMMENT ON COLUMN event_poster_layouts.partner_order IS
  'Порядок логотипов партнёров: массив id. Пусто = как в карточках события';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
