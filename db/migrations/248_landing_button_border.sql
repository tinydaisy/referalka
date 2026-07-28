-- 248: Градиентная заливка и рамка кнопок лендинга (миграции 240-247).
--
-- Зачем. У кнопки был один цвет заливки (плюс галочка «металлик») и никакой
-- рамки. На боевых лендингах кнопка обычно выглядит иначе: градиентная
-- заливка из ДВУХ своих цветов + контрастная градиентная рамка вокруг —
-- именно это даёт «объёмную» кнопку.
--
--   btn_color_2      — второй цвет заливки; пусто = заливка одним цветом
--                      (или металлик из btn_color, как было)
--   btn_angle        — направление градиента заливки, град.
--   btn_border_color — цвет рамки; пусто = рамки нет
--   btn_border_width — толщина рамки, px
--   btn_border_metallic — рамка металлическим переливом
--
-- Как везде: дефолты пишутся в тему клиента, оттуда копируются в страницу.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_btn_color_2         TEXT,
  ADD COLUMN IF NOT EXISTS lp_btn_angle           SMALLINT DEFAULT 180,
  ADD COLUMN IF NOT EXISTS lp_btn_border_color    TEXT,
  ADD COLUMN IF NOT EXISTS lp_btn_border_width    SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lp_btn_border_metallic BOOLEAN DEFAULT FALSE;

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS btn_color_2         TEXT,
  ADD COLUMN IF NOT EXISTS btn_angle           SMALLINT NOT NULL DEFAULT 180
        CHECK (btn_angle BETWEEN 0 AND 360),
  ADD COLUMN IF NOT EXISTS btn_border_color    TEXT,
  ADD COLUMN IF NOT EXISTS btn_border_width    SMALLINT NOT NULL DEFAULT 0
        CHECK (btn_border_width BETWEEN 0 AND 12),
  ADD COLUMN IF NOT EXISTS btn_border_metallic BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;

-- Признак «стиль страницы правили вручную в самом событии».
-- Тема применяется к лендингам сразу при сохранении в Настройках, но такие
-- страницы не трогаем — иначе правка темы затирала бы ручную настройку
-- под конкретное событие.
ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS style_customized BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;

-- Анимированное свечение карточек секции (ценности, «что получите», отличия,
-- «для кого», тарифы). По кругу подсвечивается одна карточка за другой —
-- взгляд цепляется, страница перестаёт быть статичной.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS cards_glow BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;

-- Выделенный («рекомендуемый») тариф — светящаяся рамка на лендинге.
ALTER TABLE event_tariffs
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_tariffs TO plusson;

-- Цвет цены в карточке тарифа. Пусто = цвет заголовков темы.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_price_color TEXT;

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS price_color TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;

-- Заливка карточек и стиль рамки — в общей теме, применяются везде.
--   card_bg / card_bg_opacity — цвет и прозрачность внутренней заливки
--   border_style: solid — ровная рамка;
--                 fade  — яркая по углам, растворяется к середине сторон
--                 (эффект «подсвеченных углов» с боевых лендингов)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_card_bg         TEXT    DEFAULT '#0F1E2E',
  ADD COLUMN IF NOT EXISTS lp_card_bg_opacity SMALLINT DEFAULT 55,
  ADD COLUMN IF NOT EXISTS lp_border_style    TEXT    DEFAULT 'solid';

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS card_bg         TEXT,
  ADD COLUMN IF NOT EXISTS card_bg_opacity SMALLINT NOT NULL DEFAULT 55
        CHECK (card_bg_opacity BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS border_style    TEXT NOT NULL DEFAULT 'solid'
        CHECK (border_style IN ('solid', 'fade'));

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;
