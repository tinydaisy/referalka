-- 101_broadcast_log_external_message_id_text.sql
-- Расширяет broadcast_log.external_message_id с BIGINT до TEXT.
--
-- Проблема: колонка изначально была bigint (для TG message_id, которое число),
-- но email Message-ID — это строка вида '<177944591790.811245.117137...@mail.pluson.ru>'.
-- При попытке записать email-лог INSERT падал с
--   invalid input for query argument $6: '<...>' (str object cannot be interpreted as integer)
-- — и email-получатели не попадали в broadcast_log → модалка «Получатели рассылки»
-- показывала ноль email-адресов, при том что письма реально уходили.
--
-- После миграции:
--   • TG message_id хранится как строка цифр ("12345") — работа клиентов не меняется.
--   • Email Message-ID хранится как есть, со скобками и доменом.
--   • VK/MAX — тоже строкой (id числовой, но укладывается в text без потерь).

BEGIN;

ALTER TABLE broadcast_log
    ALTER COLUMN external_message_id TYPE TEXT USING external_message_id::text;

COMMENT ON COLUMN broadcast_log.external_message_id IS
    'Внешний ID сообщения (TG message_id, email Message-ID, VK conversation_message_id, MAX message_id). Хранится строкой';

COMMIT;
