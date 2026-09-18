-- 435: генератор афиш события — настройки макета.
--
-- ⚠️ ЗАЧЕМ. Афишу на 20 спикеров сегодня собирают руками в фотошопе: каждый раз
-- заново расставить фото по сетке, подписать, выделить организатора, добавить
-- логотипы партнёров. Появился спикер — макет переделывают целиком. Здесь фон и
-- оформление задаются один раз, а состав подставляется сам из карточек события.
--
-- ⚠️ ТРИ ОТДЕЛЬНЫЕ СТРОКИ НА СОБЫТИЕ (`orientation`), а не одна с общими
-- настройками. Горизонтальная, вертикальная и квадратная афиши — это РАЗНЫЕ
-- макеты, а не один в трёх размерах: на вертикальной спикеры идут по 4 в ряд и
-- заголовок в две строки, на горизонтальной — по 7 и в одну. Общие настройки
-- заставили бы выбирать компромисс, плохой везде.
--
-- ⚠️ СОСТАВ СЮДА НЕ КОПИРУЕТСЯ. Спикеры, партнёры и их фото читаются при
-- отрисовке из `conf_speaker_events` + `collaborators`. Копия разошлась бы с
-- составом в тот день, когда добавили спикера: в списке события он есть, на
-- афише его нет, и никто не понимает почему.
--
-- ⚠️ Размеры и координаты — в ПРОЦЕНТАХ полотна, как в шаблонах обложек
-- (мигр. 387). Полотно на экране редактора меньше настоящего, в пикселях всё
-- поехало бы.

BEGIN;

CREATE TABLE IF NOT EXISTS event_poster_layouts (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,

    -- Три вида афиши — у каждого свой макет и свой фон.
    orientation TEXT NOT NULL CHECK (orientation IN ('horizontal', 'vertical', 'square')),

    ---------------------------------------------------------------- фон
    -- Пусто → градиент темы бренда (lp_bg_color / lp_bg_color_2 / lp_bg_angle).
    bg_url      TEXT,
    -- Затемнение фона, 0..90 %: по светлой картинке белые подписи не читаются.
    bg_dim      INTEGER NOT NULL DEFAULT 0 CHECK (bg_dim BETWEEN 0 AND 90),

    -- ⚠️ Линия, С КОТОРОЙ начинается блок спикеров, в процентах высоты. Верх
    -- фона обычно занят рисунком и заголовком, и спикеры обязаны начинаться
    -- ниже — иначе они лягут поверх оформления фона.
    speakers_top    INTEGER NOT NULL DEFAULT 45 CHECK (speakers_top BETWEEN 0 AND 95),
    -- Докуда спикерам можно расти вниз: на фоне бывает подпись или логотип снизу.
    speakers_bottom INTEGER NOT NULL DEFAULT 97 CHECK (speakers_bottom BETWEEN 5 AND 100),
    -- Боковые поля блока спикеров.
    speakers_side   INTEGER NOT NULL DEFAULT 5 CHECK (speakers_side BETWEEN 0 AND 40),

    ------------------------------------------------- как показывать спикеров
    -- Форма рамки фото. `cutout` — вырезка на прозрачном фоне без рамки вовсе:
    -- люди стоят кучкой и перекрывают друг друга (второй стиль из примеров).
    mask_shape  TEXT NOT NULL DEFAULT 'portrait'
                CHECK (mask_shape IN ('portrait', 'square', 'circle', 'oval', 'egg', 'cutout')),
    -- Скругление углов для прямоугольных масок, % от меньшей стороны карточки.
    mask_radius INTEGER NOT NULL DEFAULT 0 CHECK (mask_radius BETWEEN 0 AND 50),
    -- Сколько человек в ряду. NULL = подобрать самим под количество и формат.
    per_row     INTEGER CHECK (per_row BETWEEN 1 AND 12),
    -- Промежуток между карточками, % ширины полотна.
    gap         NUMERIC(5,2) NOT NULL DEFAULT 2 CHECK (gap BETWEEN 0 AND 20),
    -- ⚠️ Наложение рядов друг на друга, % высоты карточки. Нужно ТОЛЬКО стилю
    -- `cutout`: там люди стоят плотной группой, задний ряд выглядывает из-за
    -- переднего. У карточек с рамками наложение = наезжающие друг на друга
    -- прямоугольники, поэтому по умолчанию 0.
    row_overlap INTEGER NOT NULL DEFAULT 0 CHECK (row_overlap BETWEEN 0 AND 60),

    ------------------------------------------------------------- подписи имён
    show_names  BOOLEAN NOT NULL DEFAULT TRUE,
    -- Порядок слов и перенос: «Имя Фамилия» / «Фамилия Имя», в строку или в две.
    name_order  TEXT NOT NULL DEFAULT 'first_last'
                CHECK (name_order IN ('first_last', 'last_first')),
    name_lines  INTEGER NOT NULL DEFAULT 2 CHECK (name_lines IN (1, 2)),
    name_font   TEXT,
    name_size   NUMERIC(5,2) NOT NULL DEFAULT 1.6 CHECK (name_size BETWEEN 0.3 AND 8),
    name_color  TEXT,
    -- ⚠️ Тень под подписью. У вырезанных спикеров подпись ложится прямо на людей
    -- и фон — без тени она теряется на светлой одежде.
    name_shadow BOOLEAN NOT NULL DEFAULT FALSE,
    -- Подпись под фото или поверх нижнего края карточки.
    name_place  TEXT NOT NULL DEFAULT 'below' CHECK (name_place IN ('below', 'over')),

    --------------------------------------------- выделение организатора/хедлайнера
    -- Чем выделяем: рамкой, свечением, обоими или ничем.
    hl_style    TEXT NOT NULL DEFAULT 'border'
                CHECK (hl_style IN ('none', 'border', 'glow', 'both')),
    -- Пусто → золото бренда (lp_color_heading, по умолчанию #FFCFA4).
    hl_color    TEXT,
    hl_border_w NUMERIC(5,2) NOT NULL DEFAULT 0.3 CHECK (hl_border_w BETWEEN 0 AND 3),
    -- Размах свечения, % ширины полотна.
    hl_glow     NUMERIC(5,2) NOT NULL DEFAULT 1.5 CHECK (hl_glow BETWEEN 0 AND 10),

    -- ⚠️ Как подписать роль хедлайнера / генерального партнёра. Требование:
    -- ИМЕНА ВСЕХ ОСТАЮТСЯ НА ОДНОМ УРОВНЕ — значит место под плашку резервируется
    -- у всех карточек, а не только у выделенных, иначе сетка поедет.
    --   pill   — плашка над именем
    --   ribbon — лента наискось через угол карточки
    --   suffix — приписка после имени через тире
    --   none   — не подписывать
    role_badge  TEXT NOT NULL DEFAULT 'pill'
                CHECK (role_badge IN ('none', 'pill', 'ribbon', 'suffix')),
    role_badge_color TEXT,
    role_badge_text_color TEXT,

    ------------------------------------------------------- заголовок и подзаголовок
    -- Пусто → название события. Клиент может вписать своё.
    title       TEXT,
    subtitle    TEXT,
    -- ⚠️ Можно не показывать вовсе: фон приезжает с уже нарисованным заголовком,
    -- и тогда генератор только расставляет спикеров.
    show_title    BOOLEAN NOT NULL DEFAULT TRUE,
    show_subtitle BOOLEAN NOT NULL DEFAULT TRUE,

    -- Оформление задаётся ОТДЕЛЬНО для заголовка и подзаголовка: у них разный
    -- кегль, цвет и часто разный шрифт.
    title_font    TEXT,
    title_size    NUMERIC(5,2) NOT NULL DEFAULT 6 CHECK (title_size BETWEEN 1 AND 20),
    title_color   TEXT,
    -- Металлический перелив — тот же приём, что на лендинге и обложках.
    title_metallic  BOOLEAN NOT NULL DEFAULT TRUE,
    title_underline TEXT NOT NULL DEFAULT 'none'
                    CHECK (title_underline IN ('none', 'line', 'gradient')),
    title_align   TEXT NOT NULL DEFAULT 'center'
                  CHECK (title_align IN ('left', 'center', 'right')),

    subtitle_font     TEXT,
    subtitle_size     NUMERIC(5,2) NOT NULL DEFAULT 2.4 CHECK (subtitle_size BETWEEN 0.5 AND 12),
    subtitle_color    TEXT,
    subtitle_metallic  BOOLEAN NOT NULL DEFAULT FALSE,
    subtitle_underline TEXT NOT NULL DEFAULT 'none'
                       CHECK (subtitle_underline IN ('none', 'line', 'gradient')),
    subtitle_align    TEXT NOT NULL DEFAULT 'center'
                      CHECK (subtitle_align IN ('left', 'center', 'right')),

    -- Где стоит текстовый блок, % полотна.
    text_top      INTEGER NOT NULL DEFAULT 18 CHECK (text_top BETWEEN 0 AND 100),

    ------------------------------------------------------------------ пилюля
    -- Плашка с датой и форматом: «23-24 апреля», «Онлайн-конференция».
    show_pill   BOOLEAN NOT NULL DEFAULT TRUE,
    -- Пусто → дата события в человеческом виде, собранная из дат события.
    pill_text   TEXT,
    pill_text_2 TEXT,
    -- Оформление: рамка со скруглением, подчёркивание или просто текст.
    pill_style  TEXT NOT NULL DEFAULT 'border'
                CHECK (pill_style IN ('border', 'filled', 'underline', 'plain')),
    pill_radius INTEGER NOT NULL DEFAULT 50 CHECK (pill_radius BETWEEN 0 AND 50),
    pill_border_color   TEXT,
    -- Второй цвет рамки — рамка градиентом.
    pill_border_color_2 TEXT,
    pill_border_w NUMERIC(5,2) NOT NULL DEFAULT 0.15 CHECK (pill_border_w BETWEEN 0 AND 2),
    pill_bg_color TEXT,
    pill_text_color TEXT,
    pill_font   TEXT,
    pill_size   NUMERIC(5,2) NOT NULL DEFAULT 1.8 CHECK (pill_size BETWEEN 0.3 AND 8),

    ----------------------------------------------------- логотипы и партнёры
    -- Логотип бренда — обязателен по требованию, но место задаёт клиент:
    -- на чужом фоне жёсткий угол наехал бы на рисунок.
    show_brand_logo BOOLEAN NOT NULL DEFAULT TRUE,
    brand_logo_variant TEXT NOT NULL DEFAULT 'light'
                       CHECK (brand_logo_variant IN ('light', 'dark')),
    brand_logo_x    INTEGER NOT NULL DEFAULT 50 CHECK (brand_logo_x BETWEEN 0 AND 100),
    brand_logo_y    INTEGER NOT NULL DEFAULT 5  CHECK (brand_logo_y BETWEEN 0 AND 100),
    brand_logo_size NUMERIC(5,2) NOT NULL DEFAULT 6 CHECK (brand_logo_size BETWEEN 1 AND 30),

    -- ⚠️ Партнёры-КОМПАНИИ идут логотипами сверху, партнёры-ЛЮДИ — в общую сетку
    -- спикеров со своим фото. Различает галочка `collaborators.is_company`
    -- (мигр. 425): логотип в портретной рамке режется по бокам, а портрет в
    -- ряду логотипов висит маленьким прямоугольником.
    show_partners BOOLEAN NOT NULL DEFAULT TRUE,
    partners_y    INTEGER NOT NULL DEFAULT 5 CHECK (partners_y BETWEEN 0 AND 100),
    partners_size NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (partners_size BETWEEN 1 AND 20),

    ------------------------------------------------------------ порядок людей
    -- ⚠️ Ручной порядок, заданный перетаскиванием: массив id коллабораторов.
    -- Пусто → расставляем сами (организаторы сверху по центру, дальше по
    -- крупности медийных активов). Кого в ручном списке нет — дописывается в
    -- конец автоматом: иначе добавленный спикер молча не попал бы на афишу.
    speaker_order JSONB NOT NULL DEFAULT '[]'::jsonb,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT event_poster_layouts_order_is_array
        CHECK (jsonb_typeof(speaker_order) = 'array')
);

-- Один макет на событие и ориентацию.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_poster_layouts
    ON event_poster_layouts (event_id, orientation);

COMMENT ON TABLE event_poster_layouts IS
  'Генератор афиш: настройки макета события, по строке на каждую ориентацию';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;
GRANT USAGE, SELECT ON SEQUENCE event_poster_layouts_id_seq TO plusson;

COMMIT;
