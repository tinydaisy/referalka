-- 387. Шаблоны обложек — настройка «как выглядит обложка по умолчанию».
--
-- Обложка нужна записи эфира (её грузят на YouTube и клеят к видео) и материалу
-- продукта. Собирать её каждый раз руками в стороннем редакторе — работа на
-- каждую запись; здесь она собирается сама из темы бренда, а поправить можно
-- поверх.
--
-- ⚠️⚠️ ДВА ВИДА, А НЕ ОДИН (`kind`): у материала и у спикера разный СМЫСЛ, а не
-- только оформление. На материале главное — название, оно занимает половину
-- полотна. На спикере — имя, роль и название конференции, сверху логотипы
-- партнёров. Один шаблон с галочками «показывать роль», «показывать партнёров»
-- превратился бы в набор исключений, где ни один случай не настроен хорошо.
--
-- ⚠️ Тема бренда СЮДА НЕ КОПИРУЕТСЯ. Цвета, шрифты и логотипы живут в
-- `clients.lp_*` / `brand_logo_url` и читаются при отрисовке. Копия разошлась бы
-- с темой в тот день, когда клиент поменяет фирменный цвет: лендинги стали бы
-- одного цвета, обложки — другого.
--
-- ⚠️ NULL в полях раскладки = «как задумано в шаблоне». Нули и координаты по
-- умолчанию не проставляем: иначе не отличить «клиент подвинул фото в левый
-- край» от «клиент не трогал», и правка шаблона перестала бы доезжать до тех,
-- кто ничего не менял.

CREATE TABLE IF NOT EXISTS cover_templates (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

    -- `material` — обложка записи/материала, `speaker` — обложка человека.
    kind        TEXT NOT NULL CHECK (kind IN ('material', 'speaker')),

    -- Фон. Пусто → берётся градиент темы клиента (lp_bg_color/_2/_angle).
    bg_url      TEXT,
    -- Затемнение фоновой картинки, 0..90 %: по светлому фото текст не читается,
    -- а осветлять само фото клиенту нечем.
    bg_dim      INTEGER NOT NULL DEFAULT 0 CHECK (bg_dim BETWEEN 0 AND 90),

    -- Какой логотип брать: тёмный фон → светлый логотип и наоборот.
    -- `none` — не показывать вовсе (например, логотип уже есть на фоне).
    logo_variant TEXT NOT NULL DEFAULT 'light'
                 CHECK (logo_variant IN ('light', 'dark', 'none')),

    -- Раскладка в ПРОЦЕНТАХ от полотна, а не в пикселях: размер обложки может
    -- смениться (сейчас 1280×720), проценты переживут это без пересчёта.
    photo_side  TEXT NOT NULL DEFAULT 'left' CHECK (photo_side IN ('left', 'right', 'none')),
    photo_scale INTEGER NOT NULL DEFAULT 100 CHECK (photo_scale BETWEEN 30 AND 200),
    photo_x     INTEGER NOT NULL DEFAULT 0   CHECK (photo_x BETWEEN -100 AND 100),
    photo_y     INTEGER NOT NULL DEFAULT 0   CHECK (photo_y BETWEEN -100 AND 100),

    -- Область заголовка: где начинается и сколько занимает.
    text_x      INTEGER NOT NULL DEFAULT 50  CHECK (text_x BETWEEN 0 AND 100),
    text_y      INTEGER NOT NULL DEFAULT 50  CHECK (text_y BETWEEN 0 AND 100),
    text_w      INTEGER NOT NULL DEFAULT 45  CHECK (text_w BETWEEN 10 AND 100),
    text_align  TEXT NOT NULL DEFAULT 'left'
                CHECK (text_align IN ('left', 'center', 'right')),
    -- Кегль заголовка в процентах от высоты полотна: 8 % от 720 = ~58 px.
    -- В процентах, потому что то же число должно работать и на превью, и в PNG.
    title_size  INTEGER NOT NULL DEFAULT 8   CHECK (title_size BETWEEN 3 AND 20),

    -- Цвета. Пусто → цвета темы (lp_color_heading / lp_color_body).
    title_color TEXT,
    text_color  TEXT,

    -- Показывать ли название бренда под заголовком.
    show_brand  BOOLEAN NOT NULL DEFAULT TRUE,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Один шаблон каждого вида на клиента: это НАСТРОЙКА по умолчанию, а не
    -- список. Своё оформление отдельной обложки живёт на ней самой.
    UNIQUE (client_id, kind)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON cover_templates TO plusson;
GRANT USAGE, SELECT ON cover_templates_id_seq TO plusson;
