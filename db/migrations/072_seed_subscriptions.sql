-- 072_seed_subscriptions.sql (07.05.2026)
-- Сидинг подписок для существующих клиентов после ввода client_subscriptions.
--
-- Правила (на момент миграции):
--   - Системный клиент (email='system@pluson.ru') → переключаем на 'vip',
--     подписка с expires_at='2099-12-31' (вечная), source='admin'.
--   - Обычные клиенты с tariff_slug='vip' → подписка с expires_at = trial_ends_at
--     (или NOW() + 30 дней если NULL), source='paid'.
--   - Клиенты с tariff_slug='trial' (бывший beta) → подписка с expires_at = trial_ends_at
--     (или NOW() + 60 дней), source='trial'.
--
-- На текущий момент (dev и прод): 2 клиента — Маргарита (vip, trial_ends_at=2027-03-18)
-- + ПЛЮСОН Сервис (trial, без trial_ends_at). После миграции:
--   Маргарита    → подписка vip   до 2027-03-18 (source='paid')
--   ПЛЮСОН Сервис → переключён на vip + подписка vip до 2099-12-31 (source='admin')

BEGIN;

-- 1. Системный клиент: переключаем на VIP
UPDATE clients
   SET tariff_slug = 'vip'
 WHERE email = 'system@pluson.ru'
   AND tariff_slug != 'vip';

-- 2. Создаём подписку для каждого активного клиента
INSERT INTO client_subscriptions (client_id, tariff_id, started_at, expires_at, status, source)
SELECT
  c.id,
  t.id,
  COALESCE(c.created_at, NOW()),
  CASE
    WHEN c.email = 'system@pluson.ru'  THEN '2099-12-31 00:00:00+00'::timestamptz
    WHEN c.trial_ends_at IS NOT NULL   THEN c.trial_ends_at
    WHEN c.tariff_slug = 'trial'       THEN COALESCE(c.created_at, NOW()) + INTERVAL '60 days'
    ELSE                                    COALESCE(c.created_at, NOW()) + INTERVAL '30 days'
  END                                                                          AS expires_at,
  CASE
    WHEN c.email = 'system@pluson.ru' THEN 'active'
    WHEN COALESCE(c.trial_ends_at, NOW() + INTERVAL '1 day') > NOW() THEN 'active'
    ELSE 'expired'
  END                                                                          AS status,
  CASE
    WHEN c.email = 'system@pluson.ru' THEN 'admin'
    WHEN c.tariff_slug = 'trial'      THEN 'trial'
    ELSE                                   'paid'
  END                                                                          AS source
  FROM clients c
  JOIN tariffs t ON t.slug = c.tariff_slug
 WHERE c.is_active = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM client_subscriptions cs WHERE cs.client_id = c.id
   );

-- 3. Заполняем denorm-указатель current_subscription_id
UPDATE clients c
   SET current_subscription_id = (
     SELECT cs.id FROM client_subscriptions cs
      WHERE cs.client_id = c.id
      ORDER BY cs.expires_at DESC, cs.id DESC
      LIMIT 1
   )
 WHERE c.current_subscription_id IS NULL
   AND c.is_active = TRUE;

COMMIT;
