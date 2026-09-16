-- 428. Период премии задаётся ДАТАМИ, а не календарным кварталом.
--
-- ⚠️⚠️ ЗАЧЕМ. Календарные кварталы не совпадают с рабочими периодами: первый
-- период начинается с середины сентября 2026 и идёт до 31.12.2026 — это не
-- «Q3» и не «Q4». Жёсткая привязка к `'2026-Q3'` заставляла бы подгонять
-- реальность под формат.
--
-- ⚠️ Название остаётся — им период называют в разговоре и в отчётах. Но границы
-- теперь явные даты, и они могут быть любыми: хоть две недели, хоть полгода.

ALTER TABLE tech_quarter_requirements
    ADD COLUMN IF NOT EXISTS starts_on DATE,
    ADD COLUMN IF NOT EXISTS ends_on   DATE,
    ADD COLUMN IF NOT EXISTS title     TEXT;

COMMENT ON COLUMN tech_quarter_requirements.starts_on IS
    'Начало периода. Пусто — период считается календарным кварталом из period.';
COMMENT ON COLUMN tech_quarter_requirements.ends_on IS
    'Конец периода включительно.';
COMMENT ON COLUMN tech_quarter_requirements.title IS
    'Как период называют вслух: «до Нового года», «осенний рывок».';

ALTER TABLE tech_bonus_funds
    ADD COLUMN IF NOT EXISTS starts_on DATE,
    ADD COLUMN IF NOT EXISTS ends_on   DATE,
    ADD COLUMN IF NOT EXISTS title     TEXT;

-- ⚠️ Активации считаются по ДАТАМ начислений, а не по строке `period` вида
-- '2026-09': при произвольных границах месяц может попадать в период частично.
-- Дату начисления берём из `created_at` таблицы `tech_accruals`.

-- Первый рабочий период: с 15.09.2026 до конца года (решение владельца).
INSERT INTO tech_quarter_requirements
    (period, starts_on, ends_on, title,
     base_from_pluson, network_from_pluson, network_own, note)
VALUES
    ('2026-H2', DATE '2026-09-15', DATE '2026-12-31', 'До Нового года',
     6, 3, 5, 'Первый рабочий период: неполный, с середины сентября')
ON CONFLICT (period) DO UPDATE SET
    starts_on = EXCLUDED.starts_on,
    ends_on   = EXCLUDED.ends_on,
    title     = EXCLUDED.title;
