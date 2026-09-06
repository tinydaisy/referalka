-- 354: Убрать фичу «Ссылка на вебинар» (`webinar_link`)
--
-- Задумывалась как урезанный уровень: Экстра — своя вебинарная комната
-- (`webinar_room`), Профи — только ссылка на чужую (`webinar_link`).
--
-- По прод-базе на 06.09.2026 обе фичи привязаны к ОДНОМУ И ТОМУ ЖЕ набору
-- тарифов (trial, pro, vip, admin), а `_assert_webinar_feature` проверяет
-- комнату ПЕРВОЙ — значит ветка 'link' не срабатывала ни у одного клиента
-- ни разу. В карточке тарифа при этом стояли две строки подряд: «Вебинарная
-- комната» и «Ссылка на вебинар», из которых вторая выглядела отдельной
-- урезанной возможностью, хотя ничего не давала.
--
-- То же самое, что с `broadcast_chats_one` (миграция 353): два уровня доступа,
-- разведённые только на бумаге, а в данных выданные всем сразу.
--
-- ⚠️ Вернуть уровень «только ссылка» = завести фичу заново И снять
-- `webinar_room` с младших тарифов. Одного добавления фичи мало — иначе
-- повторится ровно эта ситуация.
--
-- Ссылок на фичу нет: tariff_features 4 строки (снимаем), client_addons,
-- addon_orders, feature_bundles, client_price_locks, tariff_bonus_grants,
-- plusson_bonus_coupons, event_tariffs.bonus_feature_id — пусто.

DELETE FROM tariff_features
 WHERE feature_id = (SELECT id FROM features WHERE slug = 'webinar_link');

DELETE FROM features WHERE slug = 'webinar_link';
