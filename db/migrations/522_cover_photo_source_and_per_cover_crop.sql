-- 522. Обложки записей: выбор источника фото + правка кадра у КАЖДОЙ обложки
--      (26.09.2026, по прямому требованию владельца)
--
-- ЗАЧЕМ. Обложки собираются пачкой на весь день, а фото у людей разные, и
-- одной общей настройки не хватает:
--
--   1. ИСТОЧНИК ФОТО — один на всю пачку, задаётся НАД списком обложек.
--      ⚠️ Названия — ТЕ ЖЕ, что в карточке спикера, буква в букву: человек
--      настраивает их там и ищет здесь знакомое слово. «Индивидуальная афиша»
--      из первой редакции убрана — это готовый макет, а не фото:
--        'cutout'  — «Фото на прозрачном фоне» (вырезка), по умолчанию;
--        'profile' — «Фото для сайта» из карточки спикера;
--        'event'   — фото, выбранное ДЛЯ ЭТОГО СОБЫТИЯ (миграция 472).
--      До сих пор источник был жёстко зашит в коде («вырезка, иначе фото»), и
--      выбрать другое было нельзя вовсе.
--
--   2. ПРАВКА КАДРА У КАЖДОЙ ОБЛОЖКИ ОТДЕЛЬНО — сдвиг влево/вправо,
--      вверх/вниз и размер. Общие настройки шаблона одни на всех, а снимки
--      сняты по-разному: одного обрезает по шее, другой уходит вбок. Правка
--      живёт ЗДЕСЬ, а не в карточке спикера, потому что карточка общая для
--      афиш, программы и лендинга — поправив кадр ради обложки, человек
--      сдвинул бы себе всё остальное.
--
-- ⚠️ Умолчания нулевые: у уже собранных обложек вид не меняется.

-- ── 1. Источник фото — свойство СОБЫТИЯ (одно на все обложки всех дней) ──
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS cover_photo_source text NOT NULL DEFAULT 'cutout';

ALTER TABLE events
    DROP CONSTRAINT IF EXISTS events_cover_photo_source_chk;
ALTER TABLE events
    ADD CONSTRAINT events_cover_photo_source_chk
    CHECK (cover_photo_source IN ('cutout', 'profile', 'event'));

COMMENT ON COLUMN events.cover_photo_source IS
    'Что брать как фото на обложках записей: cutout (фото на прозрачном фоне) / profile (фото для сайта) / event (фото, выбранное для этого события).';

-- ── 2. Правка кадра у конкретной обложки ────────────────────────────────
ALTER TABLE event_speaker_covers
    ADD COLUMN IF NOT EXISTS photo_dx    integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS photo_dy    integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS photo_zoom  numeric(4,2) NOT NULL DEFAULT 1.00;

COMMENT ON COLUMN event_speaker_covers.photo_dx IS
    'Сдвиг фото влево/вправо, % ширины кадра. 0 — как есть.';
COMMENT ON COLUMN event_speaker_covers.photo_dy IS
    'Сдвиг фото вверх/вниз, % высоты кадра. 0 — как есть.';
COMMENT ON COLUMN event_speaker_covers.photo_zoom IS
    'Приближение фото на ЭТОЙ обложке. 1.00 — как задано в шаблоне.';

-- ── 3. Настройки надписей: имя спикера и название конференции ───────────
--
-- ЗАЧЕМ. В шаблоне настраивался ТОЛЬКО размер заголовка. Цвет имени тянулся
-- из темы, шрифта не было вовсе, а у названия конференции кегль (22 px) и
-- межбуквенный интервал стояли числами прямо в коде — поправить их было
-- нечем. Обложка при этом живёт отдельной жизнью от лендинга: её несут на
-- YouTube и в мессенджеры, и подогнать надписи под конкретный фон должно
-- быть можно, не трогая фирменные стили всего кабинета.
--
-- ⚠️ Всё NULL по умолчанию = «как раньше»: пусто → берётся значение из темы
-- бренда или прежнее число из кода. Собранные обложки не меняются.
ALTER TABLE cover_templates
    -- Имя спикера (заголовок)
    ADD COLUMN IF NOT EXISTS title_font      text,
    ADD COLUMN IF NOT EXISTS title_align     text,
    ADD COLUMN IF NOT EXISTS title_upper     boolean NOT NULL DEFAULT false,
    -- Название конференции (надстрочник)
    ADD COLUMN IF NOT EXISTS overline_size   numeric(4,1) NOT NULL DEFAULT 3.1,
    ADD COLUMN IF NOT EXISTS overline_color  text,
    ADD COLUMN IF NOT EXISTS overline_font   text,
    ADD COLUMN IF NOT EXISTS overline_upper  boolean NOT NULL DEFAULT true,
    -- Тема выступления: цвет и шрифт (размер уже есть — миграция 515)
    ADD COLUMN IF NOT EXISTS subtitle_color  text,
    ADD COLUMN IF NOT EXISTS subtitle_font   text;

ALTER TABLE cover_templates
    DROP CONSTRAINT IF EXISTS cover_templates_title_align_chk;
ALTER TABLE cover_templates
    ADD CONSTRAINT cover_templates_title_align_chk
    CHECK (title_align IS NULL OR title_align IN ('left', 'center', 'right'));

COMMENT ON COLUMN cover_templates.title_font IS
    'Шрифт имени спикера (ключ из справочника темы). NULL — шрифт заголовков темы.';
COMMENT ON COLUMN cover_templates.title_align IS
    'Выравнивание имени. NULL — как у всего текстового блока.';
COMMENT ON COLUMN cover_templates.title_upper IS
    'Имя ЗАГЛАВНЫМИ буквами.';
COMMENT ON COLUMN cover_templates.overline_size IS
    'Кегль названия конференции, % высоты полотна (3.1% ≈ 22px при 720px).';
COMMENT ON COLUMN cover_templates.overline_color IS
    'Цвет названия конференции. NULL — цвет текста темы.';
COMMENT ON COLUMN cover_templates.overline_font IS
    'Шрифт названия конференции. NULL — шрифт основного текста темы.';
COMMENT ON COLUMN cover_templates.overline_upper IS
    'Название конференции ЗАГЛАВНЫМИ (как было до появления настройки).';
COMMENT ON COLUMN cover_templates.subtitle_color IS
    'Цвет темы выступления. NULL — цвет текста темы бренда.';
COMMENT ON COLUMN cover_templates.subtitle_font IS
    'Шрифт темы выступления. NULL — шрифт основного текста темы.';

-- ⚠️ GRANT в той же миграции: роль plusson не владелец таблиц, и без этого
-- новые колонки приложению не видны (правило проекта).
GRANT SELECT, INSERT, UPDATE, DELETE ON event_speaker_covers TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON events TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON cover_templates TO plusson;
