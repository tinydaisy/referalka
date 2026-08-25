-- 332: фича «Фирменный стиль Mini App» — тарифы Экстра и admin
--
-- Галочка «использовать фирменные цвета» (мигр. 331) становится платной
-- возможностью: своё оформление там, куда клиент приводит аудиторию, — это
-- то же, за что берут деньги в «Своём домене» и «Отзывах» (обе на Экстра).
--
-- ⚠️ Гейтить ТОЛЬКО по фиче (`client_has_feature`), никогда по `tariff_slug`:
-- состав тарифов меняется данными, без правок кода.
--
-- ⚠️ Триал НЕ зеркалим. Правило «триал = Профи» касается фич, привязанных к
-- `pro`; эта привязана к `vip`, поэтому в триал не попадает — как `autowebinar`
-- и `custom_domain`.
INSERT INTO features (slug, name)
VALUES ('miniapp_brand_theme', 'Фирменный стиль Mini App')
ON CONFLICT (slug) DO NOTHING;

-- Экстра (vip) + admin. Системный сервисный клиент (id 3, «ПЛЮСОН Сервис»)
-- сидит на тарифе `admin` — проверено на проде, — поэтому отдельной строки
-- ему не нужно: фича достаётся вместе с тарифом.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t
  CROSS JOIN features f
 WHERE f.slug = 'miniapp_brand_theme'
   AND t.slug IN ('vip', 'admin')
ON CONFLICT DO NOTHING;
