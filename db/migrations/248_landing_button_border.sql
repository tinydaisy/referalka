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
