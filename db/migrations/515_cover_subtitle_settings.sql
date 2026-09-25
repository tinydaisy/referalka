-- 515. Тема выступления на обложке: свои настройки + ограничение по высоте
--      (25.09.2026)
--
-- ЗАЧЕМ. В шаблоне обложки настраивался только ЗАГОЛОВОК (имя спикера):
-- ширина области, кегль, положение. А подзаголовок — тему выступления —
-- настроить было нечем вовсе: его кегль стоял числом прямо в коде
-- (`fontSize: 30` в CoverCanvas). Тема у спикера длинная, в отличие от
-- образца «спикер» в предпросмотре, и на реальных данных она:
--   • не влезала в отведённую область и вылезала за неё;
--   • ложилась поверх фото, потому что фото у большинства спикеров НЕ
--     вырезанное — прямоугольный снимок занимает свою половину полотна
--     целиком, и «свободной» половины под текст просто нет.
--
-- ⚠️ Область текста ограничивала ТОЛЬКО ширину. По высоте блок centered по
-- `text_y` и рос в обе стороны без предела — поэтому «заданная область» на
-- длинной теме переставала что-либо задавать.
--
-- Что добавляем:
--   subtitle_size     — кегль темы, в процентах высоты полотна (как
--                       title_size у заголовка). 2.8% ≈ прежние 30 px на
--                       полотне 720 px, то есть у существующих шаблонов вид
--                       не меняется;
--   subtitle_lines    — сколько строк темы показывать; дальше — многоточием.
--                       0 = без ограничения (прежнее поведение);
--   text_h            — высота области текста в процентах полотна. 0 = без
--                       ограничения, как было;
--   text_fit          — ужимать ли содержимое под область автоматически.
--
-- ⚠️ ВСЕ значения по умолчанию подобраны так, чтобы УЖЕ СОХРАНЁННЫЕ шаблоны
-- выглядели ровно как раньше. Обложки уже разосланы спикерам, и молча
-- поменять вид у всех — значит расписаться в том, что старые файлы неверные.

-- ⚠️⚠️ ПОЛОВИНА СПИКЕРОВ БЕЗ ВЫРЕЗКИ. На событии 89 из 18 видимых спикеров
-- вырезка на прозрачном фоне есть ровно у 9. У остальных обычный прямоугольный
-- снимок: он закрывает свою половину полотна ЦЕЛИКОМ, и «свободной» половины
-- под текст не остаётся — текст ложится прямо на фотографию.
--
-- Лечится тем же приёмом, что в генераторе афиш: фото кладётся в ФИГУРУ
-- (портрет / квадрат / круг / овал), а не раскладывается во всю высоту.
--   photo_shape — форма кадра. 'cutout' (по умолчанию) — прежнее поведение:
--                 фото во всю высоту, как и было, для вырезок оно верное;
--   photo_w     — ширина фигуры в % полотна (для 'cutout' не применяется);
--   photo_radius, photo_fade — скругление и растушёвка правого края, чтобы
--                 прямоугольный снимок не выглядел наклейкой на фоне.

ALTER TABLE cover_templates
    ADD COLUMN IF NOT EXISTS subtitle_size  numeric(4,1) NOT NULL DEFAULT 4.2,
    ADD COLUMN IF NOT EXISTS subtitle_lines integer      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS text_h         integer      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS text_fit       boolean      NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS photo_shape    text         NOT NULL DEFAULT 'cutout',
    ADD COLUMN IF NOT EXISTS photo_w        integer      NOT NULL DEFAULT 38,
    ADD COLUMN IF NOT EXISTS photo_radius   integer      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS photo_fade     integer      NOT NULL DEFAULT 0;

-- ⚠️ CHECK, а не доверие фронту: значение приходит из браузера и может быть
-- любым, а разъехавшийся список форм рисуется как «квадрат по умолчанию» молча.
ALTER TABLE cover_templates
    DROP CONSTRAINT IF EXISTS cover_templates_photo_shape_chk;
ALTER TABLE cover_templates
    ADD CONSTRAINT cover_templates_photo_shape_chk
    CHECK (photo_shape IN ('cutout', 'portrait', 'square', 'circle', 'oval'));

COMMENT ON COLUMN cover_templates.subtitle_size IS
    'Кегль темы выступления, % высоты полотна (4.2% ≈ 30px при 720px).';
COMMENT ON COLUMN cover_templates.subtitle_lines IS
    'Сколько строк темы показывать, дальше многоточие. 0 — без ограничения.';
COMMENT ON COLUMN cover_templates.text_h IS
    'Высота области текста, % полотна. 0 — не ограничивать (как было).';
COMMENT ON COLUMN cover_templates.text_fit IS
    'Ужимать содержимое под высоту области, если не помещается.';
COMMENT ON COLUMN cover_templates.photo_shape IS
    'Форма кадра фото: cutout (во всю высоту, как было) / portrait / square / circle / oval.';
COMMENT ON COLUMN cover_templates.photo_w IS
    'Ширина фигуры фото, % полотна. Для cutout не применяется.';
COMMENT ON COLUMN cover_templates.photo_radius IS
    'Скругление углов фигуры, % ширины.';
COMMENT ON COLUMN cover_templates.photo_fade IS
    'Растушёвка края фото в сторону текста, % ширины фигуры. 0 — резкий край.';

-- ⚠️ GRANT в той же миграции: роль plusson не владелец таблиц, и без этого
-- новые колонки будут не видны приложению (правило проекта).
GRANT SELECT, INSERT, UPDATE, DELETE ON cover_templates TO plusson;
