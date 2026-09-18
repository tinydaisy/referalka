-- 446: логотипы афиши — ОДНА строка, общие правила, и скрытие поштучно.
--
-- ⚠️⚠️ ЛОГОТИП БРЕНДА НАЕЗЖАЛ НА ЛОГОТИПЫ ПАРТНЁРОВ. Он ставился отдельно, по
-- собственным координатам X/Y, а партнёры — своей строкой по центру. Две
-- независимые раскладки в одном месте листа неизбежно пересекаются: клиент
-- двигает бренд к центру и накрывает им партнёров, а «подвинуть, чтобы не
-- мешал» приходится вручную на каждом формате заново.
--
-- Теперь логотип бренда встаёт В ТУ ЖЕ СТРОКУ, что и партнёры, по тем же
-- правилам: общий размер, общий промежуток, общее выравнивание. Пересечься они
-- больше не могут по построению — это один ряд, а не два слоя.
--
-- ⚠️ СВЕТЛЫЙ/ТЁМНЫЙ — ОБЩЕЕ РЕШЕНИЕ, А НЕ У КАЖДОГО СВОЁ. Фон афиши один, и
-- «этот логотип для тёмного, а соседний для светлого» — бессмыслица. Поле
-- `logos_variant` заменяет прежний `brand_logo_variant` и действует на всех.
--
-- ⚠️ А вот СКРЫТИЕ — наоборот, поштучное: клиент прячет конкретный логотип
-- (например свой бренд, когда на афише уже есть логотип ПЛЮСОНа), остальные
-- остаются. Поэтому `logos_hidden` — список id, а не галочка.

BEGIN;

ALTER TABLE event_poster_layouts
  -- Выравнивание всей строки логотипов: по центру, слева или справа.
  ADD COLUMN IF NOT EXISTS logos_align TEXT NOT NULL DEFAULT 'center'
      CHECK (logos_align IN ('left', 'center', 'right')),
  -- Промежуток между логотипами, % ширины рабочей области.
  ADD COLUMN IF NOT EXISTS logos_gap NUMERIC(5,2) NOT NULL DEFAULT 2.5
      CHECK (logos_gap BETWEEN 0 AND 20),
  -- Какой вариант логотипа брать — ОДИН на всю строку.
  ADD COLUMN IF NOT EXISTS logos_variant TEXT NOT NULL DEFAULT 'light'
      CHECK (logos_variant IN ('light', 'dark')),
  -- ⚠️ Скрытые логотипы — поштучно. Бренд обозначается строкой 'brand'
  -- (у него нет id коллаборатора), партнёры — своими id.
  ADD COLUMN IF NOT EXISTS logos_hidden JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Порядок логотипов в строке, вместе с брендом: ['brand', 12, 7].
  ADD COLUMN IF NOT EXISTS logos_order JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE event_poster_layouts
  DROP CONSTRAINT IF EXISTS event_poster_layouts_logos_hidden_is_array;
ALTER TABLE event_poster_layouts
  ADD CONSTRAINT event_poster_layouts_logos_hidden_is_array
  CHECK (jsonb_typeof(logos_hidden) = 'array');

ALTER TABLE event_poster_layouts
  DROP CONSTRAINT IF EXISTS event_poster_layouts_logos_order_is_array;
ALTER TABLE event_poster_layouts
  ADD CONSTRAINT event_poster_layouts_logos_order_is_array
  CHECK (jsonb_typeof(logos_order) = 'array');

COMMENT ON COLUMN event_poster_layouts.logos_align IS
  'Выравнивание ВСЕЙ строки логотипов (бренд + партнёры)';
COMMENT ON COLUMN event_poster_layouts.logos_gap IS
  'Промежуток между логотипами, % ширины рабочей области';
COMMENT ON COLUMN event_poster_layouts.logos_variant IS
  'Вариант логотипа для фона афиши — ОДИН на всех: light (для тёмного фона) / dark';
COMMENT ON COLUMN event_poster_layouts.logos_hidden IS
  'Скрытые логотипы поштучно: id партнёров и строка brand для логотипа бренда';
COMMENT ON COLUMN event_poster_layouts.logos_order IS
  'Порядок логотипов в строке вместе с брендом: ["brand", 12, 7]. Пусто = бренд первым';

-- Переносим прежний выбор варианта логотипа бренда на общую настройку.
UPDATE event_poster_layouts
   SET logos_variant = brand_logo_variant
 WHERE brand_logo_variant IN ('light', 'dark');

-- Прежняя галочка «не показывать логотип бренда» → скрытие поштучно.
UPDATE event_poster_layouts
   SET logos_hidden = '["brand"]'::jsonb
 WHERE show_brand_logo IS FALSE;

COMMENT ON COLUMN event_poster_layouts.brand_logo_variant IS
  'УСТАРЕЛО (мигр. 446): вариант логотипа общий — logos_variant';
COMMENT ON COLUMN event_poster_layouts.brand_logo_x IS
  'УСТАРЕЛО (мигр. 446): логотип бренда стоит в общей строке, своих координат нет';
COMMENT ON COLUMN event_poster_layouts.brand_logo_y IS
  'УСТАРЕЛО (мигр. 446): см. brand_logo_x';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
