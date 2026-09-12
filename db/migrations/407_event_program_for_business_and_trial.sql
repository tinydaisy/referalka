-- 407: «Программа по дням у мероприятий» — Бизнесу и Триалу.
--
-- ⚠️ Дыра в данных, а не в коде. Миграция 401 завела фичу `event_program` и
-- выдала её ТОЛЬКО `vip` и `admin` — про `business_beta` забыли, хотя Бизнес
-- (4990 ₽) дороже Экстры (2990 ₽) и по замыслу включает всё, что в ней есть.
-- Получалось, что на самом дорогом тарифе раздела нет, а на более дешёвом — есть.
--
-- ⚠️ В Триал дыра ПЕРЕТЕКЛА: миграция 404 копировала состав Триала запросом
-- из `business_beta` — а там фичи не было, копировать было нечего. Отсюда
-- «Триал = Бизнес» переставало быть правдой ровно в одном пункте.
--
-- Правило остаётся прежним: Триал показывает ВСЁ, за что человек потом платит.
--
-- ⚠️ На всякий случай берём объединение: и явную выдачу Бизнесу, и повторное
-- зеркало Бизнес → Триал. Если в Бизнес позже добавят ещё что-то мимо Триала,
-- второй запрос это подхватит.

-- 1. Бизнесу — то, что есть у Экстры, но не доехало до него.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT (SELECT id FROM tariffs WHERE slug = 'business_beta'), tf.feature_id
  FROM tariff_features tf
  JOIN tariffs t ON t.id = tf.tariff_id
 WHERE t.slug = 'vip'
ON CONFLICT DO NOTHING;

-- 2. Триалу — полное зеркало Бизнеса (после пункта 1 оно уже с программой).
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT (SELECT id FROM tariffs WHERE slug = 'trial'), tf.feature_id
  FROM tariff_features tf
  JOIN tariffs t ON t.id = tf.tariff_id
 WHERE t.slug = 'business_beta'
ON CONFLICT DO NOTHING;
