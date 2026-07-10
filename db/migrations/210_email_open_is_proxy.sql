-- 210_email_open_is_proxy.sql
--
-- ПРОБЛЕМА. Раньше открытия писем, пришедшие от почтовых прокси
-- (GoogleImageProxy, Apple Mail Privacy, Yandex, Rambler), молча
-- ВЫБРАСЫВАЛИСЬ и в email_open_log не попадали вовсе.
--
-- Но Gmail показывает картинки ТОЛЬКО через GoogleImageProxy — другого
-- способа у него нет. В базе клиента Gmail это ~50% адресов, и все их
-- открытия терялись: в email_open_log ноль записей с GoogleImageProxy.
-- Итог — open rate 0.5% там, где реально десятки процентов.
--
-- РЕШЕНИЕ. Пишем ВСЕ загрузки пикселя, помечая прокси флагом is_proxy.
-- Тогда «открыли» = все загрузки (сопоставимо с GetCourse/Mailchimp),
-- а при желании всегда можно отделить прокси-предзагрузки от «живых».
--
-- Старые строки: помечаем как прокси те, чей user_agent — известный
-- прокси-резайзер. Остальные оставляем FALSE (были «живыми» открытиями).

BEGIN;

ALTER TABLE email_open_log
    ADD COLUMN IF NOT EXISTS is_proxy BOOLEAN NOT NULL DEFAULT FALSE;

-- Бэкфилл: то, что уже лежит в таблице и явно является прокси.
-- (GoogleImageProxy сюда не попадёт — его записей нет, он отбрасывался.)
UPDATE email_open_log
   SET is_proxy = TRUE
 WHERE is_proxy = FALSE
   AND user_agent IS NOT NULL
   AND (
        user_agent ILIKE '%ImageProxy%'
     OR user_agent ILIKE '%ImageResizer%'
     OR user_agent ILIKE '%GoogleImageProxy%'
     OR user_agent ILIKE '%YahooMailProxy%'
   );

-- Считаем «открыли N человек» — индекс под DISTINCT contact_id по рассылке.
CREATE INDEX IF NOT EXISTS idx_email_open_log_proxy
    ON email_open_log(broadcast_log_id, is_proxy);

COMMIT;
