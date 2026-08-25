-- 333: СВОИ цвета Mini App — отдельно от «Стилей лендингов»
--
-- Зачем. Миграция 331 тянула цвета из лендинга (`clients.lp_*`), и это
-- оказалось неверным по сути: там ДЕСЯТЬ отдельных настроек (цвет заголовка,
-- вкладки дня, карточки, текста, границ), заданных для другой вёрстки и
-- другого фона. В Mini App их механический перенос дал разнобой из пяти
-- несочетающихся оттенков и нечитаемый текст на тёмных плашках.
--
-- ⚠️ В MINI APP ВСЕГО ТРИ ЦВЕТА (решение владельца): синий фон, персиковый
-- акцент и кнопка призыва к действию. Всё остальное — производные от них
-- через прозрачность. Поэтому здесь ровно ПЯТЬ полей цвета + два угла
-- градиента, а не копия палитры лендинга.
--
-- ⚠️ Лендинг НЕ ТРОГАЕМ. Оформление продающей страницы и оформление кабинета
-- участника — разные задачи: на лендинге карточки лежат на тёмном фоне и сами
-- тёмные, в Mini App те же карточки светлые на белой подложке. Одна общая
-- палитра на оба места неизбежно ломает одно из них.
ALTER TABLE clients
  -- 1. Синий: фон, шапка, тёмные плашки.
  ADD COLUMN IF NOT EXISTS ma_bg_color      TEXT    NOT NULL DEFAULT '#25455D',
  ADD COLUMN IF NOT EXISTS ma_bg_color_2    TEXT    NOT NULL DEFAULT '#0a1520',
  ADD COLUMN IF NOT EXISTS ma_bg_angle      INTEGER NOT NULL DEFAULT 45,
  -- 2. Персиковый: иконки, стрелки, акценты, заливка карточек (20%).
  ADD COLUMN IF NOT EXISTS ma_accent_color  TEXT    NOT NULL DEFAULT '#FFCFA4',
  -- 3. Кнопка призыва к действию («ПОЛУЧИТЬ ЗАПИСИ») — заливка + граница.
  ADD COLUMN IF NOT EXISTS ma_cta_color     TEXT    NOT NULL DEFAULT '#dc2626',
  ADD COLUMN IF NOT EXISTS ma_cta_color_2   TEXT    NOT NULL DEFAULT '#7f1d1d',
  ADD COLUMN IF NOT EXISTS ma_cta_angle     INTEGER NOT NULL DEFAULT 135,
  ADD COLUMN IF NOT EXISTS ma_cta_border    TEXT    NOT NULL DEFAULT '#7f1d1d',
  -- 4. Скругление элементов: карточки, кнопки, плашки.
  -- ⚠️ Одно значение на всё, а не «радиус кнопки» отдельно от «радиуса
  -- карточки»: разные скругления рядом читаются как небрежность вёрстки.
  ADD COLUMN IF NOT EXISTS ma_radius        INTEGER NOT NULL DEFAULT 14;

COMMENT ON COLUMN clients.ma_bg_color     IS 'Mini App: основной фон (синий), первый цвет градиента';
COMMENT ON COLUMN clients.ma_accent_color IS 'Mini App: акцент (персиковый) — иконки, стрелки, карточки';
COMMENT ON COLUMN clients.ma_cta_color    IS 'Mini App: кнопка призыва к действию, первый цвет градиента';

-- ⚠️ Значения по умолчанию — ТЕКУЩИЕ цвета платформы. Клиент, включивший
-- галочку и ничего не менявший, увидит ровно тот же Mini App, что и раньше:
-- «фирменные цвета» становятся отправной точкой для правок, а не внезапной
-- перекраской.
--
-- ⚠️ Переносим цвета тех, кто УЖЕ включил галочку (мигр. 331): у них Mini App
-- сейчас покрашен из лендинга, и после этой миграции он не должен измениться
-- сам по себе.
UPDATE clients
   SET ma_bg_color     = COALESCE(NULLIF(lp_bg_color, ''),   ma_bg_color),
       ma_bg_color_2   = COALESCE(NULLIF(lp_bg_color_2, ''), ma_bg_color_2),
       ma_bg_angle     = COALESCE(lp_bg_angle,               ma_bg_angle),
       ma_accent_color = COALESCE(NULLIF(lp_icon_color, ''), ma_accent_color),
       ma_cta_color    = COALESCE(NULLIF(lp_btn_color, ''),  ma_cta_color),
       ma_cta_color_2  = COALESCE(NULLIF(lp_btn_color_2, ''),ma_cta_color_2),
       ma_cta_angle    = COALESCE(lp_btn_angle,              ma_cta_angle),
       ma_cta_border   = COALESCE(NULLIF(lp_btn_border_color, ''), ma_cta_border)
 WHERE miniapp_use_brand_theme;
