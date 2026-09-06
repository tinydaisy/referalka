-- 357: Строка «Уведомления о лидах в закрытую группу/канал»
--
-- Клиент заводит свой закрытый канал (или группу) и добавляет туда бота — и
-- каждый новый интерес падает туда сразу: кто пришёл, откуда, по чьей ссылке,
-- с кликабельными ссылками на его аккаунты. Настраивается в Настройки →
-- Технические → «Каналы уведомлений», работает на трёх площадках сразу
-- (`clients.notifications_telegram_chat_id` / `notifications_max_chat_id` /
-- `notifications_vk_peer_id`, единая точка — `notify_organizer_all_channels`).
--
-- В списке возможностей тарифа этого не было, хотя для клиента это главное
-- «я узнаю о заявке в ту же секунду, а не когда зайду в кабинет».
--
-- ⚠️ Строка ОПИСАТЕЛЬНАЯ, как `dialogs` (356), `referral_program` (355) и
-- `miniapp_funnels` (353): `client_has_feature('lead_notifications')` нигде не
-- вызывается, уведомления работают у всех.
--
-- sort = 28 — следом за личной перепиской (25): обе строки про «клиент не
-- пропускает людей», сначала уведомление, потом ответ.

INSERT INTO features (slug, name, description, sort)
VALUES ('lead_notifications',
        'Уведомления о лидах в закрытую группу/канал',
        'Новый интерес приходит в закрытый канал или группу клиента сразу: кто пришёл, '
        'по чьей ссылке, с ссылками на его аккаунты. Telegram, MAX и ВКонтакте. '
        'Описательная строка тарифа — доступ ничем не гейтится.',
        28)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort = EXCLUDED.sort;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT tf.tariff_id, (SELECT id FROM features WHERE slug = 'lead_notifications')
  FROM tariff_features tf
 WHERE tf.feature_id = (SELECT id FROM features WHERE slug = 'lead_magnets')
ON CONFLICT DO NOTHING;
