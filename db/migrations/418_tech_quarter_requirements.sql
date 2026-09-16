-- 418. Условия премии задаются НА КАЖДЫЙ КВАРТАЛ и различают источник клиента.
--
-- ⚠️⚠️ ЗАЧЕМ. Оборот внедренца может складываться из СТАРОЙ работы: клиенты
-- платят, платформа нравится, а новых обращений человек не ведёт. Премия за
-- такое — плата за прошлое. Условие должно требовать СВЕЖЕЙ работы каждый
-- квартал, и разной по источнику:
--   • тип Б — 6 активаций от ПЛЮСОНА в месяц (его работа — внедрять выданных);
--   • тип В — 3 от ПЛЮСОНА + 5 своих (он и внедряет, и привлекает).
--
-- ⚠️ Пороги МЕНЯЮТСЯ КАЖДЫЙ КВАРТАЛ (решение владельца 16.09.2026): условия
-- зависят от плана на период, а не задаются раз навсегда. Поэтому таблица с
-- периодом, а не одна строка в `tech_settings`.
--
-- ⚠️ Прежние `network_role_activations` и `bonus_min_activations` (миграция 417)
-- остаются как ЗНАЧЕНИЯ ПО УМОЛЧАНИЮ: если на квартал условий не задали, работа
-- не должна вставать.

CREATE TABLE IF NOT EXISTS tech_quarter_requirements (
    period          TEXT PRIMARY KEY,        -- '2026-Q1'
    -- Сколько активаций КЛИЕНТОВ ПЛЮСОНА нужно в месяц.
    base_from_pluson  INTEGER NOT NULL DEFAULT 6,
    -- Для типа В: сколько от ПЛЮСОНА и сколько СВОИХ в месяц.
    network_from_pluson INTEGER NOT NULL DEFAULT 3,
    network_own         INTEGER NOT NULL DEFAULT 5,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tech_quarter_requirements IS
    'Условия допуска к премии на конкретный квартал. Владелец задаёт их заранее; '
    'нет строки на период — берутся значения по умолчанию из tech_settings.';

COMMENT ON COLUMN tech_quarter_requirements.base_from_pluson IS
    'Тип Б: активаций клиентов ПЛЮСОНА в месяц. Требует свежей работы, иначе '
    'премию получал бы человек, живущий на старом обороте.';

COMMENT ON COLUMN tech_quarter_requirements.network_own IS
    'Тип В: активаций СВОИХ приведённых в месяц — сверх активаций от ПЛЮСОНА. '
    'Тип В и внедряет, и привлекает, поэтому условий два.';

-- Текущий и следующий квартал — чтобы система работала сразу после выкатки.
INSERT INTO tech_quarter_requirements
    (period, base_from_pluson, network_from_pluson, network_own, note)
VALUES
    (to_char(NOW(), 'YYYY') || '-Q' || to_char(NOW(), 'Q'), 6, 3, 5,
     'Стартовые условия'),
    (to_char(NOW() + INTERVAL '3 months', 'YYYY') || '-Q'
        || to_char(NOW() + INTERVAL '3 months', 'Q'), 6, 3, 5,
     'Стартовые условия')
ON CONFLICT (period) DO NOTHING;

-- ⚠️ Тип В теперь определяется тем же порогом «своих активаций», что задан на
-- квартал (`network_own`), а не отдельной настройкой: два разных числа для
-- одного и того же расходились бы при каждой правке.
UPDATE tech_settings
   SET note = note || ' ⚠️ С миграции 418 используется только как значение по '
                      'умолчанию, когда на квартал условия не заданы.'
 WHERE key IN ('network_role_activations', 'bonus_min_activations')
   AND note NOT LIKE '%миграции 418%';
