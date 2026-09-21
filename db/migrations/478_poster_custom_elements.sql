-- 478: произвольные элементы на афише + общие настройки оформления.
--
-- ⚠️⚠️ ЗАЧЕМ. До сих пор каждый элемент афиши был зашит в код со своим
-- набором настроек: у пилюль текст брался из данных события и стирался не
-- полностью (вместо пустого поля подставлялась «кривая дата»), добавить
-- третий текстовый блок было нельзя вовсе, а у роли и имени не было ни
-- фона, ни рамки, ни ВЕРХНЕГО РЕГИСТРА.
--
-- Владелец предложил верное решение (21.09.2026): «может, сделать просто
-- добавление произвольного элемента? но разного типа — и у каждого цвет
-- текста, размер, положение, шрифт, граница, скругление». То есть
-- предустановленные элементы (роль, имя, тема, фото, логотипы) — частные
-- случаи ОДНОГО типа с общим набором свойств.
--
-- Формат `custom_elements` (JSONB-массив), каждый элемент:
--   id        — свой id для перетаскивания и удаления;
--   kind      — 'text' (произвольный) либо предустановленный: 'role',
--               'name', 'topic', 'photo', 'logos', 'subtitle';
--   text      — содержимое для kind='text'; у предустановленных не нужен;
--   x, y      — положение в % рабочей области;
--   w         — ширина блока, % (чтобы длинный текст переносился);
--   size      — кегль в пикселях полотна;
--   color, bg, bg_opacity, border_color, border_w, radius, glow,
--   font, align, upper, metallic — оформление.
--
-- ⚠️ Одно поле-массив, а не таблица: элементы живут только внутри своего
-- макета, редактируются целиком и не участвуют в связях. Таблица дала бы
-- три ручки и джойн там, где достаточно чтения строки.

BEGIN;

ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS custom_elements JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ⚠️ Именно массив: объект сюда приедет при первой ошибке фронта, и `.map()`
-- по нему свалит всю афишу.
ALTER TABLE event_poster_layouts
  DROP CONSTRAINT IF EXISTS event_poster_layouts_custom_elements_check;
ALTER TABLE event_poster_layouts
  ADD CONSTRAINT event_poster_layouts_custom_elements_check
  CHECK (jsonb_typeof(custom_elements) = 'array');

COMMENT ON COLUMN event_poster_layouts.custom_elements IS
  'Произвольные элементы афиши: [{id, kind, text, x, y, w, size, color, bg, '
  'border_color, border_w, radius, glow, font, align, upper, metallic}]';

-- ── Общие настройки предустановленных текстов ────────────────────────────
--
-- ⚠️ ВЕРХНИЙ РЕГИСТР И ФОН — У ВСЕХ ТЕКСТОВ. Роль печаталась заглавными
-- жёстко в коде, а у имени и темы такой настройки не было вовсе. Фона и
-- прозрачности не было ни у одного текста.
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_role_upper BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ind_name_upper BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ind_topic_upper BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ind_title_upper BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ind_role_bg TEXT,
  ADD COLUMN IF NOT EXISTS ind_name_bg TEXT,
  ADD COLUMN IF NOT EXISTS ind_topic_bg TEXT,
  ADD COLUMN IF NOT EXISTS ind_title_bg TEXT;

-- ── Рамка и свечение у фото спикера ──────────────────────────────────────
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_photo_border_w NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (ind_photo_border_w BETWEEN 0 AND 40),
  ADD COLUMN IF NOT EXISTS ind_photo_border_color TEXT,
  ADD COLUMN IF NOT EXISTS ind_photo_glow NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (ind_photo_glow BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS ind_photo_glow_color TEXT;

-- ── Блок тем: где стоит дата и разделитель ───────────────────────────────
--
-- ⚠️ Дата слева (как было), сверху или справа — просил владелец.
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_topic_when_place TEXT NOT NULL DEFAULT 'left'
      CHECK (ind_topic_when_place IN ('left', 'top', 'right')),
  ADD COLUMN IF NOT EXISTS ind_topic_divider BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN event_poster_layouts.ind_topic_when_place IS
  'Где дата относительно темы: left — слева в строку, top — над темой, '
  'right — справа';

-- ⚠️⚠️ ВЫРАВНИВАНИЕ ПО ВЕРХНЕЙ ГРАНИЦЕ. Элемент ставился серединой на
-- указанную точку, и при двух темах у Марго Форбс блок наезжал на роль:
-- вниз он рос в обе стороны. По вертикали привязываемся к ВЕРХУ, по
-- горизонтали — к центру (просьба владельца 21.09.2026).
ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS anchor_top BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN event_poster_layouts.anchor_top IS
  'Позиция по вертикали задаёт ВЕРХНЮЮ границу элемента, а не его центр: '
  'блок растёт вниз и не наезжает на то, что выше';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
