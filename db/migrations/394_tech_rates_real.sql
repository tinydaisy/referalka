-- 394. Настоящие ставки внедренцев — по листу «2. KPI и проценты».
--
-- ⚠️⚠️ ПРЕДЫДУЩИЕ СТАВКИ БЫЛИ ВЫДУМАНЫ и не совпадали с договорённостями ни в
-- чём: там стояли фиксированные суммы (500/300/300 ₽), а на деле выплаты —
-- ПРОЦЕНТ ОТ ТАРИФА клиента, уровней два, у фикса ступенчатая вилка по числу
-- клиентов, и есть квартальная премия, которой не было вовсе.
--
-- Источник: таблица «Внедренец ПЛЮСОН», лист «2. KPI и проценты».
--
-- ⚠️ Всё в БАЗЕ, а не в коде: лист прямо говорит «ставки — единственное место,
-- где их меняют». Значит и у нас правка ставки не должна требовать выкатки.

-- ── Ставки в процентах от тарифа ─────────────────────────────────────────
-- ⚠️ Старая таблица `tech_rates` держала копейки ИЛИ процент, а нужен процент
-- ОТ ЦЕНЫ ТАРИФА клиента: у Профи 20 % это 398 ₽, у Бизнеса — 980 ₽. Считать
-- суммой нельзя, она разная.
ALTER TABLE tech_rates
    ADD COLUMN IF NOT EXISTS of_tariff BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tech_rates.of_tariff IS
    'TRUE — percent считается от ЦЕНЫ ТАРИФА клиента (активация, оживление, '
    'проценты за приведённых). FALSE — amount_kopecks как есть.';

-- Активация: 20 % от тарифа. Три условия (10+ новых подписчиков через воронку,
-- оплата после триала, вторая оплата) — выплата по третьему.
UPDATE tech_rates SET percent = 20, amount_kopecks = 0, of_tariff = TRUE
 WHERE kind = 'activation';

-- Оживление: 15 % от тарифа, после 2+ месяцев неоплаты. Платим сразу.
UPDATE tech_rates SET percent = 15, amount_kopecks = 0, of_tariff = TRUE
 WHERE kind = 'revival';

-- Свой приведённый: 10 % ПОЖИЗНЕННО, ежемесячно пока платит.
UPDATE tech_rates SET percent = 10, amount_kopecks = 0, of_tariff = TRUE
 WHERE kind = 'referral';

-- Второй уровень: 5 %. Первые 4 месяца без условий, дальше — порог по линии.
INSERT INTO tech_rates (kind, amount_kopecks, percent, of_tariff)
VALUES ('referral2', 0, 5, TRUE)
ON CONFLICT (kind) DO UPDATE SET percent = 5, of_tariff = TRUE;

-- Фикс больше не плоский: считается по ступеням (таблица ниже).
UPDATE tech_rates SET amount_kopecks = 0, percent = 0 WHERE kind = 'fix';

ALTER TABLE tech_rates DROP CONSTRAINT IF EXISTS tech_rates_kind_check;
ALTER TABLE tech_rates ADD CONSTRAINT tech_rates_kind_check
    CHECK (kind IN ('activation', 'revival', 'fix', 'referral', 'referral2'));

ALTER TABLE tech_accruals DROP CONSTRAINT IF EXISTS tech_accruals_kind_check;
ALTER TABLE tech_accruals ADD CONSTRAINT tech_accruals_kind_check
    CHECK (kind IN ('activation', 'revival', 'fix', 'referral', 'referral2',
                    'quarter_bonus', 'bonus'));

-- ── Ступени фикса ────────────────────────────────────────────────────────
-- ⚠️⚠️ ФИКС — ВИЛКА, А НЕ СУММА ЗА КАЖДОГО. Платится ОДНА сумма за диапазон:
-- 15–49 клиентов → 4 000 ₽ за всех сразу, а не за каждого. Умножение на число
-- клиентов дало бы на сотне 30 000 вместо 12 000.
--
-- ⚠️ Считаются только клиенты, привлечённые НЕ внедренцем (от партнёров и
-- трафика владельца): за своих он получает 10 %, и брать за них ещё и фикс —
-- двойная выплата за одного человека.
CREATE TABLE IF NOT EXISTS tech_fix_tiers (
    id          SERIAL PRIMARY KEY,
    clients_from INTEGER NOT NULL,
    clients_to   INTEGER NOT NULL,
    amount_kopecks INTEGER NOT NULL,
    UNIQUE (clients_from, clients_to)
);

INSERT INTO tech_fix_tiers (clients_from, clients_to, amount_kopecks) VALUES
    (0,    14,       0),
    (15,   49,  400000),
    (50,   99,  700000),
    (100, 199, 1200000),
    (200, 300, 1800000)
ON CONFLICT (clients_from, clients_to) DO NOTHING;

-- ── Квартальная премия за долю доживших ──────────────────────────────────
-- ⚠️ Доля доживших = из впервые оплативших за квартал сколько сделали ВТОРУЮ
-- оплату. Считается по ВСЕМ клиентам в работе — и своим, и чужим.
--
-- ⚠️ Считается ЧЕРЕЗ МЕСЯЦ после конца квартала: у оплативших в последние недели
-- срок второй оплаты ещё не наступил, и сразу после квартала доля выходила бы
-- заниженной.
CREATE TABLE IF NOT EXISTS tech_quarter_tiers (
    id        SERIAL PRIMARY KEY,
    rate_from NUMERIC(5,2) NOT NULL,
    rate_to   NUMERIC(5,2) NOT NULL,
    amount_kopecks INTEGER NOT NULL,
    UNIQUE (rate_from, rate_to)
);

INSERT INTO tech_quarter_tiers (rate_from, rate_to, amount_kopecks) VALUES
    (0,  40,       0),
    (40, 55, 1000000),
    (55, 70, 2000000),
    (70, 100, 3000000)
ON CONFLICT (rate_from, rate_to) DO NOTHING;

-- ── Прочие правила из листа ──────────────────────────────────────────────
-- Пороги и сроки, которые не являются ставками, но задают поведение расчёта.
CREATE TABLE IF NOT EXISTS tech_settings (
    key   TEXT PRIMARY KEY,
    value NUMERIC NOT NULL,
    note  TEXT
);

INSERT INTO tech_settings (key, value, note) VALUES
    ('revival_silence_months', 2,
     'Сколько месяцев неоплаты делают клиента остывшим'),
    ('activation_min_subscribers', 10,
     'Сколько НОВЫХ подписчиков через воронку нужно для активации'),
    ('level2_free_months', 4,
     'Сколько месяцев 2-й уровень платится без условий'),
    ('level2_quarter_threshold', 20,
     'Новых оплативших за квартал по линии — иначе 2-й уровень на паузе')
ON CONFLICT (key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    tech_fix_tiers, tech_quarter_tiers, tech_settings TO plusson;
GRANT USAGE, SELECT ON
    tech_fix_tiers_id_seq, tech_quarter_tiers_id_seq TO plusson;
