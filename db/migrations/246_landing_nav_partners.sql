-- 246: Шапка-меню лендинга + блок партнёров + режим показа карточек
--      (миграции 240-245).
--
-- 1. ШАПКА С МЕНЮ (`event_landing_pages.nav_*`)
--    Липкая полоса сверху: логотип бренда слева, пункты меню справа + кнопка.
--    Пункты — якоря на секции этой же страницы, поэтому хранить их отдельной
--    таблицей незачем: массив [{label, block_kind}] в JSONB.
--    `nav_enabled` = показывать шапку, `nav_button_label` = подпись кнопки
--    (ведёт на регистрацию), `nav_items` = сами пункты.
--
-- 2. БЛОК «ПАРТНЁРЫ» (`kind='partners'`)
--    Живой блок: карточки берутся из event_collaborators роли
--    general_partner/partner. Отдельных колонок не нужно — тип блока
--    свободный TEXT, как у остальных.
--
-- 3. РЕЖИМ ПОКАЗА КАРТОЧЕК (`event_landing_blocks.display_mode`)
--    `grid`   — сетка в N колонок (как сейчас, дефолт)
--    `scroll` — горизонтальная лента с прокруткой
--    Нужен спикерам и партнёрам: при 15 спикерах сетка занимает пол-экрана,
--    лентой компактнее. Галерея свой режим держит внутри items (mode) —
--    её не трогаем, чтобы не ломать уже собранные блоки.

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS nav_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS nav_button_label TEXT,
  ADD COLUMN IF NOT EXISTS nav_items        JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN event_landing_pages.nav_items IS
  'Пункты меню шапки: [{label, block_kind}] — якоря на секции этой страницы.';

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS display_mode TEXT NOT NULL DEFAULT 'grid'
        CHECK (display_mode IN ('grid', 'scroll'));

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages  TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;

-- Внутреннее имя секции — чтобы в списке конструктора отличать несколько
-- «Своих секций» друг от друга. На лендинге НЕ показывается: заголовок
-- секции для посетителя — это `title`.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS admin_name TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
