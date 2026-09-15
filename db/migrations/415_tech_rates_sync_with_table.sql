-- 415. Ставки внедренцев — синхронизация с таблицей «Внедренец ПЛЮСОН»
-- (листы «2. Ставки и KPI», «4. Прогноз Б», «5. Прогноз В»), сверка 15.09.2026.
--
-- ⚠️⚠️ ЧТО РАЗОШЛОСЬ. Миграция 394 брала ставки из прежней версии таблицы.
-- С тех пор владелец пересобрал расчёт: активация выросла, оживление выросло
-- вдвое, появилась ОТДЕЛЬНАЯ выплата за удержание (второй месяц) и третий
-- уровень партнёрской сети. Ставки правятся в админке, но стартовые значения
-- должны совпадать с таблицей, иначе первый же расчёт разойдётся с прогнозом.
--
-- ⚠️ УДЕРЖАНИЕ РАНЬШЕ НЕ НАЧИСЛЯЛОСЬ ВОВСЕ — вида не было ни в `tech_rates`,
-- ни в CHECK. По таблице это 30 % от тарифа за вторую оплату, то есть вторая
-- по величине регулярная выплата. Без неё внедренец недополучал больше всего.

-- ── Новые виды: удержание и третий уровень ───────────────────────────────
-- ⚠️ CHECK расширяем ДО вставки: иначе INSERT упрётся в старое ограничение
-- и миграция откатится целиком (та же причина, что в 394).
ALTER TABLE tech_rates DROP CONSTRAINT IF EXISTS tech_rates_kind_check;
ALTER TABLE tech_rates ADD CONSTRAINT tech_rates_kind_check
    CHECK (kind IN ('activation', 'retention', 'revival', 'fix',
                    'referral', 'referral2', 'referral3'));

ALTER TABLE tech_accruals DROP CONSTRAINT IF EXISTS tech_accruals_kind_check;
ALTER TABLE tech_accruals ADD CONSTRAINT tech_accruals_kind_check
    CHECK (kind IN ('activation', 'retention', 'revival', 'fix',
                    'referral', 'referral2', 'referral3',
                    'quarter_bonus', 'bonus'));

-- ── Ставки по таблице ────────────────────────────────────────────────────
-- Активация: 25 % от тарифа (было 20 %).
UPDATE tech_rates SET percent = 25, amount_kopecks = 0, of_tariff = TRUE
 WHERE kind = 'activation';

-- Оживление: 30 % от тарифа (было 15 %).
UPDATE tech_rates SET percent = 30, amount_kopecks = 0, of_tariff = TRUE
 WHERE kind = 'revival';

-- Удержание: 30 % от тарифа за ВТОРУЮ оплату. Нового вида раньше не было.
INSERT INTO tech_rates (kind, amount_kopecks, percent, of_tariff)
VALUES ('retention', 0, 30, TRUE)
ON CONFLICT (kind) DO UPDATE SET percent = 30, of_tariff = TRUE, is_active = TRUE;

-- Третий уровень сети: 2 %.
-- ⚠️ Считаем три уровня ВСЕМ (решение владельца 15.09.2026): у обычного
-- партнёра линии такой глубины просто не будет и строка останется пустой —
-- это дешевле, чем держать две разные механики для партнёров и внедренцев.
INSERT INTO tech_rates (kind, amount_kopecks, percent, of_tariff)
VALUES ('referral3', 0, 2, TRUE)
ON CONFLICT (kind) DO UPDATE SET percent = 2, of_tariff = TRUE, is_active = TRUE;

-- ── Первая ступень фикса ─────────────────────────────────────────────────
-- ⚠️ Было 0 ₽ за 1–14 клиентов — по таблице 700 ₽. Остальные ступени совпали.
UPDATE tech_fix_tiers SET amount_kopecks = 70000
 WHERE clients_from = 0 AND clients_to = 14;
