-- 241: Тема лендинга по умолчанию на уровне КЛИЕНТА.
--
-- Зачем. Без темы каждое новое событие начиналось с белого листа — клиент
-- заново выставлял фон, шрифты и цвета под свой бренд. Теперь фирменный стиль
-- задаётся ОДИН раз в Настройках, а конструктор лендинга (миграция 240)
-- подставляет его при создании страницы события.
--
-- ⚠️ Тема — именно ДЕФОЛТ, а не жёсткая привязка: значения копируются в
-- `event_landing_pages` в момент создания страницы. Дальше клиент правит
-- оформление конкретного события, и правка темы задним числом уже созданные
-- лендинги не ломает.
--
-- Дефолты в колонках = фирменный стиль ПЛЮСОНа: синий градиент в чёрный,
-- персиковый металлик на акцентах.

ALTER TABLE clients
  -- Фон: градиент от bg_color к bg_color_2 под углом bg_angle (как #25455D → #0a1520, 45°).
  ADD COLUMN IF NOT EXISTS lp_bg_color       TEXT    DEFAULT '#25455D',
  ADD COLUMN IF NOT EXISTS lp_bg_color_2     TEXT    DEFAULT '#0a1520',
  ADD COLUMN IF NOT EXISTS lp_bg_angle       SMALLINT DEFAULT 45,
  ADD COLUMN IF NOT EXISTS lp_bg_gradient    BOOLEAN DEFAULT TRUE,

  -- Заголовки: Bebas Neue, персиковый металлик.
  ADD COLUMN IF NOT EXISTS lp_font_heading   TEXT    DEFAULT 'BebasNeue',
  ADD COLUMN IF NOT EXISTS lp_color_heading  TEXT    DEFAULT '#FFCFA4',
  ADD COLUMN IF NOT EXISTS lp_heading_metallic BOOLEAN DEFAULT TRUE,

  -- Основной текст: Roboto, белый.
  ADD COLUMN IF NOT EXISTS lp_font_body      TEXT    DEFAULT 'Roboto',
  ADD COLUMN IF NOT EXISTS lp_color_body     TEXT    DEFAULT '#FFFFFF',

  -- Ссылки — персиковые.
  ADD COLUMN IF NOT EXISTS lp_color_link     TEXT    DEFAULT '#FFCFA4',

  -- Кнопки — персиковый металлик, тёмный текст.
  ADD COLUMN IF NOT EXISTS lp_btn_color      TEXT    DEFAULT '#FFCFA4',
  ADD COLUMN IF NOT EXISTS lp_btn_text_color TEXT    DEFAULT '#0a1520',
  ADD COLUMN IF NOT EXISTS lp_btn_metallic   BOOLEAN DEFAULT TRUE,

  -- Границы карточек (спикеры, тарифы, секции) — персиковый металлик.
  ADD COLUMN IF NOT EXISTS lp_border_color   TEXT    DEFAULT '#FFCFA4',
  ADD COLUMN IF NOT EXISTS lp_border_metallic BOOLEAN DEFAULT TRUE,

  -- Иконки — персиковый металлик.
  ADD COLUMN IF NOT EXISTS lp_icon_color     TEXT    DEFAULT '#FFCFA4',
  ADD COLUMN IF NOT EXISTS lp_icon_metallic  BOOLEAN DEFAULT TRUE,

  -- Единое скругление: кнопки, карточки, границы блоков.
  ADD COLUMN IF NOT EXISTS lp_radius         SMALLINT DEFAULT 5;

COMMENT ON COLUMN clients.lp_radius IS
  'Скругление углов лендинга в px — одно на кнопки, карточки и блоки.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Страница лендинга: поля, которых не было в 240 (второй цвет градиента,
-- угол, цвет ссылок, металлик заголовков и границ, единое скругление).
-- Дефолты NULL — «взять из темы клиента» на момент создания страницы.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS bg_color_2        TEXT,
  ADD COLUMN IF NOT EXISTS bg_angle          SMALLINT DEFAULT 45,
  ADD COLUMN IF NOT EXISTS bg_gradient       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS color_link        TEXT,
  ADD COLUMN IF NOT EXISTS heading_metallic  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS border_color      TEXT,
  ADD COLUMN IF NOT EXISTS border_metallic   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS radius            SMALLINT NOT NULL DEFAULT 5;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;

-- ─────────────────────────────────────────────────────────────────────────────
-- Раскладка секции: заголовок сверху / слева / справа + картинка в секции.
-- ─────────────────────────────────────────────────────────────────────────────
-- Зачем. Продающие лендинги редко идут одной колонкой: крупный заголовок слева,
-- список пунктов справа — это стандартный приём (см. ivision.pluson.ru).
-- `layout`:
--   top   — заголовок сверху, содержимое под ним (как было, дефолт)
--   left  — заголовок в левой колонке, содержимое в правой
--   right — зеркально: заголовок справа, содержимое слева
-- На узком экране (мобильный) любая раскладка схлопывается в одну колонку —
-- заголовок сверху, содержимое под ним. Правило проекта: проверять на 375px.
--
-- Картинка внутри секции (не фон, а именно контент — фото, скриншот, коллаж):
-- `image_url` + `image_position` (left|right|top|bottom) + ширина колонки в %.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS layout          TEXT NOT NULL DEFAULT 'top'
                    CHECK (layout IN ('top', 'left', 'right')),
  ADD COLUMN IF NOT EXISTS image_url       TEXT,
  ADD COLUMN IF NOT EXISTS image_position  TEXT NOT NULL DEFAULT 'right'
                    CHECK (image_position IN ('left', 'right', 'top', 'bottom')),
  -- Ширина колонки заголовка/картинки в процентах. 50 = поровну.
  ADD COLUMN IF NOT EXISTS split_ratio     SMALLINT NOT NULL DEFAULT 50
                    CHECK (split_ratio BETWEEN 20 AND 80);

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
