-- 474: у названия конференции на афише спикера свои размер, цвет и выключка.
--
-- ⚠️ ЗАЧЕМ. В подвкладке «Название конфы» не было ни размера, ни цвета —
-- кегль считался как 90 % от кегля роли, цвет был зашит полупрозрачным белым.
-- «Размер не регулируется никак» (владелец, 20.09.2026): настройка выглядела
-- пустой, потому что и была пустой.
--
-- Заодно выключка у роли и названия: была только у имени, темы и времени.

BEGIN;

ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_title_size NUMERIC(5,1) NOT NULL DEFAULT 22
      CHECK (ind_title_size BETWEEN 8 AND 120),
  ADD COLUMN IF NOT EXISTS ind_title_color TEXT,
  ADD COLUMN IF NOT EXISTS ind_title_font TEXT,
  ADD COLUMN IF NOT EXISTS ind_title_align TEXT NOT NULL DEFAULT 'center'
      CHECK (ind_title_align IN ('left', 'center', 'right')),
  ADD COLUMN IF NOT EXISTS ind_role_align TEXT NOT NULL DEFAULT 'center'
      CHECK (ind_role_align IN ('left', 'center', 'right'));

COMMENT ON COLUMN event_poster_layouts.ind_title_size IS
  'Кегль названия конференции на афише спикера, px. Раньше считался как 90 % '
  'от кегля роли и своей настройки не имел';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
