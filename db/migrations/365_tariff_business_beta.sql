-- 365: Тариф «Бизнес Beta» — продукты и партнёрская программа за деньги
--
-- Зачем. `products` (свои продукты и услуги вне событий) и `partner_program`
-- (свои партнёры клиента за вознаграждение) были написаны, но не продавались:
-- обе фичи висели ТОЛЬКО на `admin`. Теперь это отдельный тариф — четвёртый,
-- выше Экстры.
--
--            за мес    6 мес (−12%)      12 мес (−20%)
--   Профи       1990      1751,20            1592,00
--   Экстра      2990      2631,20            2392,00
--   Бизнес Beta 4900      4312,00            3920,00
--            итого       25 872,00          47 040,00
--
-- ⚠️⚠️ ПРОДУКТЫ И ПАРТНЁРКА В ЭКСТРУ НЕ ДОБАВЛЯЮТСЯ (решение владельца) —
-- иначе за новый тариф некому платить: он тем и отличается. Клиенту на Экстре,
-- которому нужны продукты, придётся перейти на «Бизнес Beta».
-- Проверено перед выкаткой: продуктами пользуются клиенты 1 и 3, партнёркой —
-- клиент 1, все на тарифе `admin`. Ни у кого раздел не пропадает.
--
-- ⚠️ Состав фич копируется ИЗ ЭКСТРЫ ЗАПРОСОМ, а не переписывается списком.
-- Список из 23 фич, набранный руками, разойдётся с Экстрой при первой же правке
-- её состава — и «Бизнес» молча окажется беднее тарифа, который дешевле.
--
-- ⚠️⚠️ ТАРИФ СОЗДАЁТСЯ СКРЫТЫМ (`is_active = FALSE`) — карточки LeadPay
-- (`leadpay_product_id*`) ещё не заведены, а без них оплата невозможна: цена
-- лежит в карточке, а не в запросе (см. tariff_periods.py). Показать сейчас
-- значило бы дать человеку нажать «Оплатить 4900 ₽» и получить отказ — кнопка
-- на странице подписки активна всегда, `payable` она не проверяет.
--
-- Включить = одной строкой, когда карточки появятся:
--   UPDATE tariffs SET leadpay_product_id = '…', leadpay_product_id_6mo = '…',
--          leadpay_product_id_12mo = '…', is_active = TRUE
--    WHERE slug = 'business_beta';
-- Суммы для карточек: 4900 (месяц), 25 872 (6 мес), 47 040 (12 мес).

INSERT INTO tariffs (
    slug, name, price, price_6mo, price_12mo,
    default_duration_days, contact_limit, broadcasts_daily_limit,
    is_active, bullet_points
)
SELECT
    'business_beta', 'Бизнес Beta',
    4900.00, 4312.00, 3920.00,
    30,
    -- ⚠️ Лимиты берём у Экстры, а не пишем числом: у неё они «без ограничений»
    -- (NULL), и захардкоженное значение однажды окажется меньше, чем у тарифа
    -- дешевле.
    t.contact_limit, t.broadcasts_daily_limit,
    FALSE,  -- см. предупреждение выше: включаем вместе с карточками LeadPay
    '["Всё из тарифа Экстра", "Продукты и услуги: свои страницы, тарифы и материалы", "Партнёрская программа: свои партнёры за вознаграждение"]'::jsonb
  FROM tariffs t
 WHERE t.slug = 'vip'
ON CONFLICT (slug) DO NOTHING;

-- Состав: всё из Экстры.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT nt.id, tf.feature_id
  FROM tariffs nt
  JOIN tariffs vip ON vip.slug = 'vip'
  JOIN tariff_features tf ON tf.tariff_id = vip.id
 WHERE nt.slug = 'business_beta'
ON CONFLICT DO NOTHING;

-- Плюс то, ради чего тариф и заводится.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT nt.id, f.id
  FROM tariffs nt
  JOIN features f ON f.slug IN ('products', 'partner_program')
 WHERE nt.slug = 'business_beta'
ON CONFLICT DO NOTHING;
