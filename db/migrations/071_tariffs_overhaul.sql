-- 071_tariffs_overhaul.sql (07.05.2026)
-- Полный пересмотр таблицы tariffs:
--   1. Новые колонки лимитов: contact_limit, broadcasts_daily_limit, default_duration_days
--   2. Переименование beta → trial (60 дней) — beta обновляем in-place чтобы не трогать FK
--   3. Создание новых тарифов: start (990), pro (2490). vip — обновление цены/лимитов
--   4. Сидинг tariff_features по матрице:
--                          | trial | start | pro | vip
--      lead_magnets        |   ✓   |   ✓   |  ✓  |  ✓
--      conference          |   ✓   |   —   |  ✓  |  ✓
--      awards              |   ✓   |   —   |  ✓  |  ✓
--      channels            |   ✓   |   —   |  —  |  ✓
--      export_contacts     |   ✓   |   —   |  —  |  ✓
--   5. Удаление старых колонок: allow_custom_bot, trial_months, max_events, max_participants
--      (заменены фичами и подписками)
--
-- Лимиты (зафиксированы 2026-05-07):
--   trial: 10000 контактов, безлимит рассылок,        60 дней
--   start: 1000 контактов,  10000 рассылок/сутки,     30 дней, 990 ₽
--   pro:   5000 контактов,  30000 рассылок/сутки,     30 дней, 2490 ₽
--   vip:   10000 контактов, безлимит рассылок,        30 дней, 3900 ₽

BEGIN;

-- ========== 1. Новые колонки ==========

ALTER TABLE tariffs
  ADD COLUMN IF NOT EXISTS contact_limit          INTEGER,
  ADD COLUMN IF NOT EXISTS broadcasts_daily_limit INTEGER,  -- NULL = безлимит
  ADD COLUMN IF NOT EXISTS default_duration_days  INTEGER;

-- ========== 2. Переименование beta → trial (in-place, через UPDATE FK) ==========
-- Шаг 1: переключить всех клиентов с beta на trial (FK на tariffs.slug)
-- Шаг 2: переименовать сам тариф

-- Создаём временный тариф 'trial' если ещё нет (на случай повторного прогона)
INSERT INTO tariffs (slug, name, price, is_active, contact_limit, broadcasts_daily_limit, default_duration_days)
VALUES ('trial', 'Пробный', 0, TRUE, 10000, NULL, 60)
ON CONFLICT (slug) DO UPDATE SET
  name                   = EXCLUDED.name,
  price                  = EXCLUDED.price,
  is_active              = EXCLUDED.is_active,
  contact_limit          = EXCLUDED.contact_limit,
  broadcasts_daily_limit = EXCLUDED.broadcasts_daily_limit,
  default_duration_days  = EXCLUDED.default_duration_days;

-- Переключаем клиентов beta → trial
UPDATE clients SET tariff_slug = 'trial' WHERE tariff_slug = 'beta';

-- Удаляем старый beta (после переключения FK уже не блокирует)
DELETE FROM tariffs WHERE slug = 'beta';

-- ========== 3. Новые/обновлённые тарифы ==========

INSERT INTO tariffs (slug, name, price, is_active, contact_limit, broadcasts_daily_limit, default_duration_days)
VALUES
  ('start', 'Старт', 990.00, TRUE, 1000, 10000, 30),
  ('pro',   'Профи', 2490.00, TRUE, 5000, 30000, 30)
ON CONFLICT (slug) DO UPDATE SET
  name                   = EXCLUDED.name,
  price                  = EXCLUDED.price,
  is_active              = EXCLUDED.is_active,
  contact_limit          = EXCLUDED.contact_limit,
  broadcasts_daily_limit = EXCLUDED.broadcasts_daily_limit,
  default_duration_days  = EXCLUDED.default_duration_days;

-- VIP — обновляем цену и лимиты (уже существует)
UPDATE tariffs SET
  name                   = 'VIP',
  price                  = 3900.00,
  is_active              = TRUE,
  contact_limit          = 10000,
  broadcasts_daily_limit = NULL,
  default_duration_days  = 30
WHERE slug = 'vip';

-- ========== 4. Сидинг tariff_features ==========
-- Очищаем на случай повторного прогона
DELETE FROM tariff_features
 WHERE tariff_id IN (SELECT id FROM tariffs WHERE slug IN ('trial', 'start', 'pro', 'vip'));

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE
   -- trial: всё включено (полный набор)
   (t.slug = 'trial' AND f.slug IN ('lead_magnets','conference','awards','channels','export_contacts'))
   -- start: только lead_magnets
   OR (t.slug = 'start' AND f.slug IN ('lead_magnets'))
   -- pro: lead_magnets + conference + awards
   OR (t.slug = 'pro'   AND f.slug IN ('lead_magnets','conference','awards'))
   -- vip: всё
   OR (t.slug = 'vip'   AND f.slug IN ('lead_magnets','conference','awards','channels','export_contacts'));

-- ========== 5. Удаление устаревших колонок ==========

ALTER TABLE tariffs DROP COLUMN IF EXISTS allow_custom_bot;
ALTER TABLE tariffs DROP COLUMN IF EXISTS trial_months;
ALTER TABLE tariffs DROP COLUMN IF EXISTS max_events;
ALTER TABLE tariffs DROP COLUMN IF EXISTS max_participants;

-- ========== 6. NOT NULL после заполнения ==========

ALTER TABLE tariffs ALTER COLUMN contact_limit         SET NOT NULL;
ALTER TABLE tariffs ALTER COLUMN default_duration_days SET NOT NULL;
-- broadcasts_daily_limit оставляем nullable (NULL = безлимит)

COMMIT;
