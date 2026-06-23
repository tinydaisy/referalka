-- Миграция 164: Фича event_tariffs + скрытый тариф admin (бессрочный).
--
-- Зачем. Раздел «Тарифы мероприятия» (event_tariffs.py) проверялся жёстко по
-- tariff_slug == 'vip'. Это хардкод. Переводим на фичевую модель, как остальные
-- модули: появляется фича `event_tariffs` (CRUD платных тарифов события + вебхук
-- оплаты), которую можно включить в любой тариф через tariff_features.
--
-- Чтобы ничего не хардкодить под client_id Марго — заводим СКРЫТЫЙ тариф `admin`
-- (is_active=FALSE, не показывается клиентам, бессрочный). В нём включена фича
-- event_tariffs. Марго (client 1) и системного (client 3) сажаем на admin.
-- В будущем фичу event_tariffs можно просто добавить в нужный публичный тариф.

-- 1) Фича event_tariffs.
INSERT INTO features (slug, name, description, sort)
VALUES ('event_tariffs', 'Платные тарифы мероприятия',
        'Настраиваемые тарифы события (VIP и др.), приём оплаты через вебхук, оферта события.', 80)
ON CONFLICT (slug) DO NOTHING;

-- 2) Скрытый тариф admin (бессрочный, не показывается клиентам).
INSERT INTO tariffs (slug, name, price, is_active, contact_limit, broadcasts_daily_limit, default_duration_days)
VALUES ('admin', 'Администратор', 0, FALSE, 0, NULL, 36500)
ON CONFLICT (slug) DO NOTHING;

-- 3) В тариф admin включаем ВСЕ существующие фичи + event_tariffs (полный доступ).
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t
  CROSS JOIN features f
 WHERE t.slug = 'admin'
ON CONFLICT DO NOTHING;

-- 4) Пересаживаем Марго (client 1) и системного (client 3) на admin, бессрочно.
--    Обновляем существующую активную подписку → tariff admin, expires далеко в будущее.
WITH adm AS (SELECT id FROM tariffs WHERE slug = 'admin')
UPDATE client_subscriptions cs
   SET tariff_id   = (SELECT id FROM adm),
       expires_at  = '2099-12-31 00:00:00+00',
       status      = 'active',
       source      = 'admin',
       updated_at  = NOW()
 WHERE cs.client_id IN (1, 3)
   AND cs.id = (SELECT current_subscription_id FROM clients WHERE id = cs.client_id);

-- Если у кого-то из них не было current_subscription_id — создаём подписку на admin.
INSERT INTO client_subscriptions (client_id, tariff_id, started_at, expires_at, status, source)
SELECT c.id, (SELECT id FROM tariffs WHERE slug='admin'),
       NOW(), '2099-12-31 00:00:00+00', 'active', 'admin'
  FROM clients c
 WHERE c.id IN (1, 3)
   AND c.current_subscription_id IS NULL;

-- Синхронизируем денормализованный указатель clients.current_subscription_id.
UPDATE clients c
   SET current_subscription_id = (
        SELECT cs.id FROM client_subscriptions cs
         WHERE cs.client_id = c.id AND cs.status = 'active'
         ORDER BY cs.expires_at DESC, cs.id DESC LIMIT 1)
 WHERE c.id IN (1, 3);
