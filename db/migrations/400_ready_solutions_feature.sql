-- 400. Фича «Готовые решения» — пока только у админа.
--
-- Раздел с готовыми сценариями (воронка, анкета, событие, продукт) и кнопкой
-- «Установить мне». Пока обкатывается — клиентам не показываем.
--
-- ⚠️ Гейт по ФИЧЕ, а не по slug тарифа: открыть раздел клиентам = одна строка
-- в `tariff_features`, без правок кода и без выкатки.
--
-- ⚠️ Вкладка СКРЫТА без фичи, а не показана с замком — как «Автообзвоны» и
-- «Продукты». Раздел клиентам ещё не продаётся, дразнить незачем.

INSERT INTO features (slug, name, description)
VALUES ('ready_solutions', 'Готовые решения',
        'Готовые сценарии с установкой в один клик: выдача материала за подписку, '
        'запись на консультацию, розыгрыш, воронка на эфир, платный эфир, продукт.')
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
                                 description = EXCLUDED.description;

-- ⚠️ Только `admin`. Клиентам откроется отдельной строкой, когда обкатаем.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'ready_solutions'
ON CONFLICT DO NOTHING;
