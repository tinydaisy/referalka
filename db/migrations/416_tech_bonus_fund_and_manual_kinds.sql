-- 416. Премиальный фонд по весам должностей + ручные виды начислений.
--
-- ── 1. ПРЕМИЯ: фонд вводится вручную, делится по весам ─────────────────────
-- ⚠️⚠️ ПОЧЕМУ НЕ СЧИТАЕМ САМИ. По таблице фонд = процент от ПРИБЫЛИ компании
-- (ступени 5/7/10/12 % от прибыли за квартал). Прибыль складывается из выручки
-- минус налоги, инфраструктура, зарплаты команды и выплаты внедренцам — этих
-- данных в платформе нет и быть не должно: кабинет внедренца показал бы ему
-- экономику владельца. Поэтому сумму фонда за квартал вводит админ одним
-- числом, а платформа делит её по весам должностей.
--
-- ⚠️ Прежняя механика (доля доживших → ступени 0/10/20/30 тыс. ₽) ОТМЕНЕНА:
-- таблица считает премию иначе. `tech_quarter_tiers` не удаляем — там история
-- уже начисленного, и удаление унесло бы объяснение старых выплат.

CREATE TABLE IF NOT EXISTS tech_bonus_funds (
    id          SERIAL PRIMARY KEY,
    -- Квартал в виде '2026-Q1': по нему ищем, за что премия.
    period      TEXT NOT NULL UNIQUE,
    amount_kopecks BIGINT NOT NULL,
    -- ⚠️ Раздача идёт один раз: повторный прогон не должен начислить дважды.
    distributed_at TIMESTAMPTZ,
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tech_bonus_funds IS
    'Премиальный фонд за квартал. Сумму вводит админ (считается в фин-модели '
    'от прибыли компании), платформа делит её по весам должностей.';

-- ── Веса должностей ────────────────────────────────────────────────────────
-- ⚠️ Шкала 1–10, где 10 — самый ценный (решение владельца 15.09.2026).
-- Сумма весов значения не имеет: доля = вес человека / сумма весов всех.
-- Веса внедренцев зависят от ТИПА: В (со своей сетью) ценнее Б (только база).
CREATE TABLE IF NOT EXISTS tech_bonus_weights (
    role   TEXT PRIMARY KEY,
    weight NUMERIC(4,1) NOT NULL,
    note   TEXT
);

INSERT INTO tech_bonus_weights (role, weight, note) VALUES
    ('implementer_network', 9, 'Внедренец со своей сетью (тип В)'),
    ('implementer_base',    7, 'Внедренец на клиентах ПЛЮСОН (тип Б)')
ON CONFLICT (role) DO NOTHING;

-- ⚠️ Тип внедренца — на самом человеке: он определяет и вес в премии, и то,
-- какие выплаты ему вообще положены. Значение по умолчанию — «на базе»:
-- сеть строят не все, и новичок начинает с обслуживания.
ALTER TABLE tech_specialists
    ADD COLUMN IF NOT EXISTS bonus_role TEXT NOT NULL DEFAULT 'implementer_base'
        REFERENCES tech_bonus_weights(role);

-- ── 2. Ручные виды: настройки под ключ и тикеты ────────────────────────────
-- ⚠️ Автоматически их не посчитать: событий «клиент заказал настройку под ключ»
-- и «внедренец закрыл тикет» в платформе нет. Начисляются через админку
-- (POST /admin/tech/accruals/manual), суммы — по договорённости из таблицы:
-- настройки 60 % (клиент базы ПЛЮСОН) / 80 % (свой) / 100 % (мимо кассы),
-- тикеты 250 ₽ простой, 600 ₽ сложный.
ALTER TABLE tech_accruals DROP CONSTRAINT IF EXISTS tech_accruals_kind_check;
ALTER TABLE tech_accruals ADD CONSTRAINT tech_accruals_kind_check
    CHECK (kind IN ('activation', 'retention', 'revival', 'fix',
                    'referral', 'referral2', 'referral3',
                    'setup', 'ticket', 'quarter_bonus', 'bonus'));

-- ⚠️ Индекс по кварталу премии: раздача ищет уже начисленное за период,
-- чтобы не заплатить дважды при повторном запуске.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tech_quarter_bonus
    ON tech_accruals (spec_id, period) WHERE kind = 'quarter_bonus';
