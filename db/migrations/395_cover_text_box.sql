-- 395. Оформление области текста на обложке: подложка и рамка.
--
-- Зачем. Текст ложится прямо на фон, и на пёстрой картинке он теряется. Общее
-- затемнение всего фона (`bg_dim`) эту задачу не решает: оно гасит и фото
-- спикера, ради которого фон и выбирали. Нужна подложка ПОД ТЕКСТОМ.
--
-- ⚠️ Пустые значения = «подложки нет», а не «подложка прозрачная». Иначе не
-- отличить «клиент выключил» от «клиент не трогал», и правка умолчаний
-- перестала бы доезжать до тех, кто ничего не настраивал (то же правило, что у
-- остальных полей шаблона в миграции 387).
--
-- ⚠️ Градиент двумя цветами и углом — как в теме бренда (`lp_bg_color`,
-- `lp_bg_color_2`, `lp_bg_angle`). Свой формат («linear-gradient(...)» строкой)
-- пришлось бы разбирать при отрисовке и валидировать, а два цвета и угол
-- проверяются сами и настраиваются обычными полями выбора цвета.
--
-- ⚠️ Показ служебной РАЗМЕТКИ области (красный пунктир) сюда НЕ пишется: это
-- состояние экрана редактора, а не свойство обложки. В PNG она не попадает,
-- хранить её в шаблоне значило бы однажды отдать клиенту картинку с пунктиром.

ALTER TABLE cover_templates
    -- Заливка подложки. Пусто → подложки нет, текст лежит на фоне.
    ADD COLUMN IF NOT EXISTS text_bg_color   TEXT,
    -- Второй цвет градиента. Пусто → заливка одним цветом.
    ADD COLUMN IF NOT EXISTS text_bg_color_2 TEXT,
    ADD COLUMN IF NOT EXISTS text_bg_angle   INTEGER NOT NULL DEFAULT 135
        CHECK (text_bg_angle BETWEEN 0 AND 360),
    -- Прозрачность подложки, 0..100 %. 100 — плотная заливка.
    ADD COLUMN IF NOT EXISTS text_bg_opacity INTEGER NOT NULL DEFAULT 100
        CHECK (text_bg_opacity BETWEEN 0 AND 100),
    -- Скругление и внутренний отступ — в процентах ширины полотна, как всё
    -- остальное в шаблоне: обложка может сменить размер.
    ADD COLUMN IF NOT EXISTS text_bg_radius  INTEGER NOT NULL DEFAULT 0
        CHECK (text_bg_radius BETWEEN 0 AND 50),
    ADD COLUMN IF NOT EXISTS text_bg_pad     INTEGER NOT NULL DEFAULT 0
        CHECK (text_bg_pad BETWEEN 0 AND 20),

    -- Рамка области. Пусто → рамки нет.
    ADD COLUMN IF NOT EXISTS text_border_color TEXT,
    ADD COLUMN IF NOT EXISTS text_border_width INTEGER NOT NULL DEFAULT 0
        CHECK (text_border_width BETWEEN 0 AND 20);

COMMENT ON COLUMN cover_templates.text_bg_color IS
    'Заливка подложки под текстом. NULL — подложки нет, текст на фоне.';
COMMENT ON COLUMN cover_templates.text_bg_color_2 IS
    'Второй цвет градиента подложки. NULL — заливка одним цветом.';
COMMENT ON COLUMN cover_templates.text_bg_opacity IS
    'Прозрачность подложки в процентах: 100 — плотная, 0 — невидимая.';
COMMENT ON COLUMN cover_templates.text_border_width IS
    'Толщина рамки области текста в пикселях полотна 1280×720. 0 — рамки нет.';
