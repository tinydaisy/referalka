-- 388. Логотип на обложке — размер и положение.
--
-- В первой версии логотип стоял в жёстко заданном углу. Но фон у каждого свой:
-- на одном там пустое место, на другом — рисунок или лицо человека, и логотип
-- на него наезжает. Двигать его должен клиент, а не разработчик.
--
-- ⚠️ Положение в ПРОЦЕНТАХ полотна, как у фото и текста: полотно на экране
-- уменьшено, в пикселях координаты уехали бы.
--
-- ⚠️ Размер — в процентах ВЫСОТЫ полотна, а не в пикселях: то же число должно
-- одинаково работать и в предпросмотре, и в готовом PNG.

ALTER TABLE cover_templates
    ADD COLUMN IF NOT EXISTS logo_size INTEGER NOT NULL DEFAULT 7
        CHECK (logo_size BETWEEN 2 AND 30),
    ADD COLUMN IF NOT EXISTS logo_x INTEGER NOT NULL DEFAULT 88
        CHECK (logo_x BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS logo_y INTEGER NOT NULL DEFAULT 6
        CHECK (logo_y BETWEEN 0 AND 100);

COMMENT ON COLUMN cover_templates.logo_size IS
    'Высота логотипа в % от высоты полотна (7 % от 720 = ~50 px).';
COMMENT ON COLUMN cover_templates.logo_x IS
    'Положение центра логотипа по горизонтали, % ширины полотна.';
COMMENT ON COLUMN cover_templates.logo_y IS
    'Положение центра логотипа по вертикали, % высоты полотна.';
