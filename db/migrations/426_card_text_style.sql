-- 426: оформление текста в карточках спикеров и партнёров.
--
-- ⚠️ Зачем. Карточка собиралась целиком захардкоженными размерами: имя всегда
-- 1.15em и ЗАГЛАВНЫМИ, должность 0.9em, регалии 0.85em. Клиент жаловался, что
-- «всё блёкло» — и поправить это было нечем: ни размера, ни регистра, ни
-- подчёркивания в настройках блока не существовало.
--
-- Настройки живут НА БЛОКЕ, а не на карточке человека: карточки в ряду обязаны
-- выглядеть одинаково, иначе ряд визуально разъезжается (то же правило, что у
-- `btn_width` в тарифах, миграция 312).

ALTER TABLE event_landing_blocks
  -- Размеры в процентах от основного текста страницы: 100 = как задано в теме.
  -- Проценты, а не пиксели: страница масштабируется целиком (body_size), и
  -- пиксельный размер выпал бы из этого масштаба.
  ADD COLUMN IF NOT EXISTS card_name_size    INT,
  ADD COLUMN IF NOT EXISTS card_position_size INT,
  ADD COLUMN IF NOT EXISTS card_text_size    INT,
  -- Регистр имени: 'upper' — ЗАГЛАВНЫМИ (как было всегда), 'none' — как ввели.
  ADD COLUMN IF NOT EXISTS card_name_case    TEXT,
  ADD COLUMN IF NOT EXISTS card_position_case TEXT,
  -- Подчёркивание имени и его цвет. NULL = без подчёркивания (прежний вид).
  ADD COLUMN IF NOT EXISTS card_name_underline BOOLEAN,
  ADD COLUMN IF NOT EXISTS card_name_underline_color TEXT;

-- ⚠️ NULL везде = ПРЕЖНИЙ ВИД. Дефолтов у колонок нет намеренно: иначе уже
-- собранные лендинги поехали бы сами (то же решение, что у card_name_align
-- в миграции 423).
--
-- ⚠️ Значения ('upper'|'none') проверяются В КОДЕ (normalize_block_gift), а не
-- CHECK-ом: новый вариант добавится кодом, без миграции, а мусор приводится к
-- дефолту и не роняет запрос.

COMMENT ON COLUMN event_landing_blocks.card_name_size IS
  'Размер имени в карточке, % от основного текста. NULL = прежний (115%).';
COMMENT ON COLUMN event_landing_blocks.card_name_case IS
  'Регистр имени: upper — заглавными, none — как введено. NULL = upper.';
COMMENT ON COLUMN event_landing_blocks.card_name_underline IS
  'Подчёркивать имя. NULL/FALSE = без подчёркивания.';
