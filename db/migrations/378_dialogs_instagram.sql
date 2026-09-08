-- Instagram как площадка личных переписок.
--
-- ⚠️⚠️ Симптом был обманчивый: сообщение из кабинета РЕАЛЬНО уходило человеку
-- и он его получал, но в ленте переписки не появлялось. Причина — CHECK на
-- `direct_messages.platform` перечислял только telegram/vk/max, и запись
-- отвергалась уже ПОСЛЕ успешной отправки. Ошибка при этом гасилась
-- (archive_direct_message пишет её в лог и не роняет ответ), поэтому наружу
-- всё выглядело как «отправил — и ничего не произошло».
--
-- ⚠️ Перечисление площадок в CHECK — вообще ловушка: код о нём не знает, и
-- новая площадка молча перестаёт записываться. При добавлении следующей
-- (WhatsApp и т.п.) — не забыть про это ограничение.
ALTER TABLE direct_messages DROP CONSTRAINT IF EXISTS direct_messages_platform_chk;
ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_platform_chk
  CHECK (platform = ANY (ARRAY['telegram'::text, 'vk'::text, 'max'::text, 'instagram'::text]));
