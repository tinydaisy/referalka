-- 095_events_multi_chat_urls.sql
-- Несколько чатов на событие: TG / VK / MAX + выбор главного.
--
-- До: events.chat_url — одна ссылка (де-факто TG). После: 3 поля под платформы +
-- primary_chat_platform — какую показывать как «Основной чат». Поле chat_url
-- ОСТАЁТСЯ как computed shadow — бэк при PATCH пересчитывает его в значение
-- chat_url_<primary> для обратной совместимости со старыми клиентами и
-- legacy-местами кода (broadcast templates, public API).
--
-- Перенос данных: всё что было в chat_url считаем TG (исторически только TG
-- чаты и поддерживались) → копируем в chat_url_tg + primary='telegram'.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS chat_url_tg            TEXT NULL,
    ADD COLUMN IF NOT EXISTS chat_url_vk            TEXT NULL,
    ADD COLUMN IF NOT EXISTS chat_url_max           TEXT NULL,
    ADD COLUMN IF NOT EXISTS primary_chat_platform  TEXT NULL
        CHECK (primary_chat_platform IS NULL
               OR primary_chat_platform IN ('telegram','vk','max'));

UPDATE events
   SET chat_url_tg = chat_url,
       primary_chat_platform = 'telegram'
 WHERE chat_url IS NOT NULL
   AND chat_url <> ''
   AND chat_url_tg IS NULL;
