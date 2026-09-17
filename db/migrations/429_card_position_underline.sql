-- 429: подчёркивание ПОЗИЦИОНИРОВАНИЯ в карточках спикеров и партнёров.
--
-- ⚠️ Миграция 426 дала подчёркивание только имени — а подчеркнуть нужно бывает
-- и должность, причём независимо: где-то линия под именем, где-то под
-- позиционированием, где-то под обоими. Одной настройкой на двоих это не
-- выразить, поэтому у позиционирования свои поля.

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS card_position_underline BOOLEAN,
  ADD COLUMN IF NOT EXISTS card_position_underline_color TEXT;

-- ⚠️ NULL = прежний вид (без подчёркивания). Дефолтов нет намеренно: иначе на
-- собранных лендингах линии появились бы сами.

COMMENT ON COLUMN event_landing_blocks.card_position_underline IS
  'Подчёркивать позиционирование в карточке. NULL/FALSE = без подчёркивания.';
COMMENT ON COLUMN event_landing_blocks.card_position_underline_color IS
  'Цвет линии под позиционированием. NULL = акцентный цвет темы.';
