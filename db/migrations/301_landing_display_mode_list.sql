-- Раскладка блока: добавлен режим 'list' (2026-08-14).
--
-- Зачем. Блок «Для кого» (`audience`) умел только сетку карточек. На перенесённом
-- лендинге спикеров в карточках стоят скриншоты-доказательства, где главное —
-- ЦИФРЫ (2976 получателей, 21 244 подписчика, 109 зрителей в эфире). В мелкой
-- карточке сетки они нечитаемы, и доказательство перестаёт работать.
--
-- 'list' — двухуровневый список: большая картинка секции сверху, под ней пункты
-- с номерами, у каждого своя картинка во всю ширину контента. Так устроен
-- исходный лендинг на GetCourse.
ALTER TABLE event_landing_blocks
    DROP CONSTRAINT IF EXISTS event_landing_blocks_display_mode_check;
ALTER TABLE event_landing_blocks
    ADD CONSTRAINT event_landing_blocks_display_mode_check
    CHECK (display_mode IS NULL OR display_mode IN ('grid', 'scroll', 'list'));
