-- Миграция 050 — удаляем дублёр VIP-URL
--
-- VIP-предложение хранилось одновременно в conf_conferences.vip_upsell_url
-- (где его правил дашборд конференции) и events.vip_url (откуда его читает
-- Mini App). Это дубль одного и того же значения. Оставляем единый
-- источник истины — events.vip_url.
--
-- Перед удалением переносим данные: где events.vip_url пустой,
-- а в conf_conferences есть vip_upsell_url — копируем.

UPDATE events e
   SET vip_url        = cc.vip_upsell_url,
       has_vip_tariff = TRUE
  FROM conf_conferences cc
 WHERE cc.event_id = e.id
   AND COALESCE(NULLIF(cc.vip_upsell_url, ''), NULL) IS NOT NULL
   AND COALESCE(NULLIF(e.vip_url, ''), NULL) IS NULL;

ALTER TABLE conf_conferences DROP COLUMN IF EXISTS vip_upsell_url;
