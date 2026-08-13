-- 286: Общие настройки показа дашборда + какая цифра крупная (2026-08-13)
--
-- Зачем. Галочки «не показывать абсолютные / не показывать проценты» были
-- только внутри шестерёнки КАЖДОГО квадратика — их не видно, и выставлять
-- их по одной на два десятка плиток невозможно. Владелец: «галочки не у
-- каждого квадратика, а сверху — надо общую на всех; ну пусть у квадратика
-- тоже будет, но ещё общие на все покажи».
--
-- Плюс новое: какую цифру показывать КРУПНО — абсолютную («731») или
-- процент («49.4%»). Раньше крупной всегда была абсолютная.

-- ── Общие настройки дашборда (действуют на все квадратики) ────────────────
ALTER TABLE analytics_dashboards
    ADD COLUMN IF NOT EXISTS hide_absolute BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE analytics_dashboards
    ADD COLUMN IF NOT EXISTS hide_percent  BOOLEAN NOT NULL DEFAULT FALSE;
-- Что крупно: 'count' — абсолютное число, 'percent' — процент.
ALTER TABLE analytics_dashboards
    ADD COLUMN IF NOT EXISTS primary_metric TEXT NOT NULL DEFAULT 'count'
        CHECK (primary_metric IN ('count', 'percent'));

-- ── Переопределение у отдельного квадратика ───────────────────────────────
-- ⚠️ NULL = «как на дашборде» (наследуем общую настройку), TRUE/FALSE =
-- квадратик решает сам. Поэтому колонки hide_* у карточки становятся
-- nullable: без NULL нельзя отличить «клиент снял галочку» от «клиент её
-- не трогал» — и общая настройка никогда бы не применилась.
ALTER TABLE analytics_cards ALTER COLUMN hide_absolute DROP NOT NULL;
ALTER TABLE analytics_cards ALTER COLUMN hide_percent  DROP NOT NULL;
ALTER TABLE analytics_cards ALTER COLUMN hide_absolute SET DEFAULT NULL;
ALTER TABLE analytics_cards ALTER COLUMN hide_percent  SET DEFAULT NULL;

-- Существующие карточки не трогали настройки руками (фича вышла вчера), так
-- что FALSE у них — это дефолт, а не осознанный выбор. Сбрасываем в NULL,
-- чтобы общая настройка дашборда сразу заработала на всех.
UPDATE analytics_cards SET hide_absolute = NULL WHERE hide_absolute = FALSE;
UPDATE analytics_cards SET hide_percent  = NULL WHERE hide_percent  = FALSE;

-- Какая цифра крупная у конкретного квадратика; NULL = как на дашборде.
ALTER TABLE analytics_cards
    ADD COLUMN IF NOT EXISTS primary_metric TEXT
        CHECK (primary_metric IS NULL OR primary_metric IN ('count', 'percent'));

-- ⚠️ Строка-итог наверху дашборда («в базе 7330 · ответили 1479»).
-- Без неё непонятно, ОТ ЧЕГО считается процент на плитке: «49.4%» висит в
-- воздухе. Знаменатель процентов — ответившие, и это должно быть видно.
-- Отдельного поля не нужно: цифры считает бэкенд при отдаче дашборда.
