-- 114_founder_tg_channels_array.sql
-- 2026-05-26
--
-- Канал основателя клиента → массив каналов основателя.
--
-- БЫЛО: одиночный TG-канал в clients.social_links->>'telegram'
-- + clients.social_links->>'telegram_chat_id'.
--
-- СТАЛО: массив clients.social_links->'telegram_channels'
-- = [{ "url": "https://t.me/...", "chat_id": "-100...", "name": "..." }, ...]
--
-- Зачем массив: фичи «гейт по подписке в чатах» и «воронка лид-магнита»
-- проверяют подписку на ВСЕ каналы основателя одновременно (clients просили
-- иметь несколько TG-каналов).
--
-- Старые ключи 'telegram' и 'telegram_chat_id' удаляются в той же миграции,
-- весь код потребителей переписан синхронно (funnel_service, client_profile,
-- nurture, dashboard UI, Mini App).
--
-- Идемпотентно: если у клиента уже есть массив `telegram_channels`, легаси-ключи
-- просто удаляются.

BEGIN;

UPDATE clients
   SET social_links = (
     CASE
       -- Уже есть массив — на всякий случай чистим легаси-ключи и оставляем массив
       WHEN social_links ? 'telegram_channels' THEN
         (social_links - 'telegram' - 'telegram_chat_id')

       -- Есть легаси-ключ telegram c непустым значением — конвертируем в массив из одного элемента
       WHEN COALESCE(social_links->>'telegram', '') <> '' THEN
         (social_links - 'telegram' - 'telegram_chat_id')
         || jsonb_build_object(
              'telegram_channels',
              jsonb_build_array(
                jsonb_build_object(
                  'url',     social_links->>'telegram',
                  'chat_id', COALESCE(social_links->>'telegram_chat_id', ''),
                  'name',    ''
                )
              )
            )

       -- Легаси-ключей нет, массива тоже нет — просто чистим (на случай если был только telegram_chat_id без url)
       ELSE
         (social_links - 'telegram' - 'telegram_chat_id')
     END
   )
 WHERE social_links IS NOT NULL;

COMMIT;
