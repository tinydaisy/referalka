-- 419. Квалификация по обороту, фонд от прибыли, редактируемые вилки.
--
-- ⚠️⚠️ ЧЕГО НЕ ХВАТАЛО. Лист «2. Ставки и KPI» задаёт четыре набора правил,
-- которых в платформе не было вовсе:
--   • КВАЛИФИКАЦИЯ — процент 1-го уровня растёт от оборота сети (10 → 12 %);
--   • ПРЕМИАЛЬНЫЙ ФОНД — процент от ПРИБЫЛИ компании (5 → 12 %);
--   • ПЛАТНЫЕ НАСТРОЙКИ — 60 / 80 / 100 % в зависимости от того, чей клиент;
--   • ТИКЕТЫ — 250 и 600 ₽.
-- Вместо фонда от прибыли в админке висела «доля доживших» — понятия, которого
-- в системе нет (миграция 394 завела его по прежней версии таблицы).

-- ── Квалификация: процент 1-го уровня от оборота сети ────────────────────
-- ⚠️ Оборот СЕТИ — все действующие клиенты внедренца: и выданные ПЛЮСОНОМ, и
-- приведённые им. Ступень пересчитывается ежемесячно по факту.
CREATE TABLE IF NOT EXISTS tech_qualification_tiers (
    id            SERIAL PRIMARY KEY,
    turnover_from BIGINT NOT NULL,      -- копейки, оборот сети в месяц
    turnover_to   BIGINT NOT NULL,
    percent       NUMERIC(4,2) NOT NULL,
    note          TEXT,
    UNIQUE (turnover_from, turnover_to)
);

INSERT INTO tech_qualification_tiers (turnover_from, turnover_to, percent, note) VALUES
    (0,              10000000,  10.0, 'старт — все начинают здесь'),
    (10000000,       23000000,  10.5, 'шаг 0,5 п.п. Сеть примерно на 34 клиента'),
    (23000000,       50000000,  11.0, 'шаг 0,5 п.п. Сеть примерно на 80 клиентов'),
    (50000000,      100000000,  11.5, 'шаг 0,5 п.п. Сеть примерно на 172 клиента'),
    (100000000, 9999999900000,  12.0, 'потолок. Сеть примерно на 345 клиентов')
ON CONFLICT (turnover_from, turnover_to) DO NOTHING;

-- ── Премиальный фонд: процент от прибыли компании ────────────────────────
-- ⚠️ Владелец вводит ПРИБЫЛЬ за квартал, платформа сама берёт ступень и считает
-- фонд. Прежде сумму фонда вводили руками — это лишний шаг и место для ошибки:
-- ступени всё равно заданы таблицей.
CREATE TABLE IF NOT EXISTS tech_fund_tiers (
    id          SERIAL PRIMARY KEY,
    profit_from BIGINT NOT NULL,        -- копейки, прибыль компании за квартал
    profit_to   BIGINT NOT NULL,
    percent     NUMERIC(4,2) NOT NULL,
    note        TEXT,
    UNIQUE (profit_from, profit_to)
);

INSERT INTO tech_fund_tiers (profit_from, profit_to, percent, note) VALUES
    (0,              60000000,  5.0,  'стартовый уровень'),
    (60000000,      150000000,  7.0,  'компания вышла на устойчивую прибыль'),
    (150000000,     300000000, 10.0,  'зрелая стадия'),
    (300000000, 9999999900000, 12.0,  'максимальный уровень')
ON CONFLICT (profit_from, profit_to) DO NOTHING;

-- ⚠️ Прибыль за квартал — на том же фонде: из неё считается сумма. Оставляем и
-- amount_kopecks: если владелец хочет задать фонд напрямую, минуя ступени.
ALTER TABLE tech_bonus_funds
    ADD COLUMN IF NOT EXISTS profit_kopecks BIGINT,
    ADD COLUMN IF NOT EXISTS percent NUMERIC(4,2);

COMMENT ON COLUMN tech_bonus_funds.profit_kopecks IS
    'Прибыль компании за квартал. Из неё по tech_fund_tiers считается фонд.';

-- ── Платные настройки и тикеты как ставки ────────────────────────────────
-- ⚠️ Начисляются вручную, но СУММЫ должны быть в одном месте со всеми
-- остальными — иначе владелец ищет их в таблице, а начисляет по памяти.
ALTER TABLE tech_rates DROP CONSTRAINT IF EXISTS tech_rates_kind_check;
ALTER TABLE tech_rates ADD CONSTRAINT tech_rates_kind_check
    CHECK (kind IN ('activation', 'retention', 'revival', 'fix',
                    'referral', 'referral2', 'referral3',
                    'setup_pluson', 'setup_own', 'setup_direct',
                    'ticket_simple', 'ticket_hard'));

INSERT INTO tech_rates (kind, amount_kopecks, percent, of_tariff) VALUES
    ('setup_pluson',  0, 60, FALSE),
    ('setup_own',     0, 80, FALSE),
    ('setup_direct',  0, 100, FALSE),
    ('ticket_simple', 25000, 0, FALSE),
    ('ticket_hard',   60000, 0, FALSE)
ON CONFLICT (kind) DO NOTHING;

-- ── Порог 2-го уровня — в настройки, а не в код ──────────────────────────
INSERT INTO tech_settings (key, value, note) VALUES
    ('level2_quarter_threshold_v2', 20,
     'Новых оплативших за квартал по сети для 2-го уровня после 4 месяцев')
ON CONFLICT (key) DO NOTHING;

-- ⚠️ «Доля доживших» БОЛЬШЕ НЕ ИСПОЛЬЗУЕТСЯ: такого понятия в системе нет,
-- премия считается от прибыли. Таблицу не удаляем — по ней объясняются
-- премии, начисленные до 16.09.2026.
COMMENT ON TABLE tech_quarter_tiers IS
    'УСТАРЕЛО с 16.09.2026: премия считается от прибыли (tech_fund_tiers). '
    'Оставлено для объяснения ранее начисленного.';
