-- Маркер пункта в карточках лендинга: галочка / номер / иконка (2026-08-14).
--
-- Зачем. В блоке «Для кого» (`audience`) слева от заголовка была ЖЁСТКО
-- нарисована галочка. Когда пункты — это шаги («1. присоединяетесь,
-- 2. приходит аудитория, 3. растут продажи»), галочки порядок не показывают,
-- и человек не понимает, что читает последовательность.
--
-- ⚠️ Дефолт 'check' — уже собранные лендинги выглядят ровно как раньше.
ALTER TABLE event_landing_blocks
    ADD COLUMN IF NOT EXISTS marker TEXT NOT NULL DEFAULT 'check';

-- check — галочка (как было), number — номер по порядку, icon — иконка из
-- набора (ключ хранится в самой карточке: items[].icon).
ALTER TABLE event_landing_blocks
    DROP CONSTRAINT IF EXISTS event_landing_blocks_marker_chk;
ALTER TABLE event_landing_blocks
    ADD CONSTRAINT event_landing_blocks_marker_chk
    CHECK (marker IN ('check', 'number', 'icon'));
