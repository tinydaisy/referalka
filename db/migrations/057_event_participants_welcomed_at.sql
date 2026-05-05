-- 057_event_participants_welcomed_at.sql
-- Welcome-страница после регистрации + унификация ссылки лендинга на
-- events.landing_url (зафиксировано 2026-05-04).
--
-- 1. event_participants.welcomed_at — после того как is_registered становится
--    true, Mini App один раз показывает приветственный экран
--    («Поздравляем!» + кнопка «Войти в чат» + объяснение вкладок). После
--    клика «Понятно, к программе» Mini App ставит welcomed_at = now() и
--    больше эту страницу не показывает.
--
-- 2. Унификация лендинга. Конференция = запись в `events` + расширение в
--    `conf_conferences`. Поле «URL лендинга» должно быть одно — `events.landing_url`.
--    Историческое `conf_conferences.registration_url` дублирует его смыслом
--    и плодит ошибки. Переносим значения в events.landing_url (только если
--    там пусто) и удаляем колонку. Параллельно в шаблонах рассылок
--    плейсхолдер `{registration_url}` мигрируется в `{landing_url}` —
--    backend оставляет совместимость (подставляет одно и то же значение
--    в оба плейсхолдера на этапе рендера).
--
-- Применить:
--   psql -d plusson -f db/migrations/057_event_participants_welcomed_at.sql

ALTER TABLE event_participants
  ADD COLUMN IF NOT EXISTS welcomed_at TIMESTAMPTZ NULL;

-- Перенос данных: registration_url → events.landing_url для конференций,
-- где landing_url ещё не заполнен. Если оба заполнены — landing_url не трогаем
-- (это сознательный выбор клиента — он мог поправить именно landing_url).
UPDATE events e
   SET landing_url = cc.registration_url
  FROM conf_conferences cc
 WHERE cc.event_id = e.id
   AND cc.registration_url IS NOT NULL
   AND cc.registration_url <> ''
   AND (e.landing_url IS NULL OR e.landing_url = '');

-- Параллельно нормализуем шаблоны рассылок: {registration_url} → {landing_url}.
-- В тексте, в URL кнопки. Только в шаблонах конференций (типы, в которых
-- плейсхолдер использовался).
UPDATE broadcast_templates
   SET text = REPLACE(text, '{registration_url}', '{landing_url}')
 WHERE text LIKE '%{registration_url}%';

UPDATE broadcast_templates
   SET button_url = REPLACE(button_url, '{registration_url}', '{landing_url}')
 WHERE button_url LIKE '%{registration_url}%';

-- Удаляем дублирующую колонку. После этого backend и web уже работают
-- через events.landing_url.
ALTER TABLE conf_conferences
  DROP COLUMN IF EXISTS registration_url;
