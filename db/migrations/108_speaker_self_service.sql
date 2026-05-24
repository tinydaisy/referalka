-- 108_speaker_self_service.sql
-- 2026-05-24
--
-- Большой пакет для самообслуживания спикеров (полный план миграции 104 из
-- архитектуры — занял номер 108, потому что 104..107 уже заняты другими
-- фичами на момент применения).
--
-- 1) collaborators.access_code TEXT NOT NULL UNIQUE (8 симв, безопасный
--    алфавит без 0/o/1/l/i). Общий код спикера, открывает любое его событие.
-- 2) collaborators.vk_url, collaborators.max_url — публичные каналы спикера
--    (по аналогии с tg_channel_url, instagram_url). НЕ личные идентичности.
-- 3) event_collaborators.knowledge_base_title / knowledge_base_url —
--    «материал в базу знаний» на это событие (название + ссылка).
-- 4) event_collaborators.show_topic_field / show_gift_after_speech_field /
--    show_knowledge_base_field — тогглы видимости в self-edit-форме спикера.
--    Подарок розыгрыша не имеет своего тоггла — он показывается, если
--    глобально event_raffle_settings.is_enabled = TRUE.

BEGIN;

-- 1. access_code на коллаба ─────────────────────────────────────────────────
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS access_code TEXT;

-- Backfill для существующих коллабов: генерим 8-символьный код из
-- безопасного алфавита через md5(random() + id). Повторяем до уникальности —
-- для 55 коллабов на dev и пары сотен на проде коллизия крайне маловероятна.
UPDATE collaborators
   SET access_code = SUBSTR(
       TRANSLATE(
           MD5(random()::text || id::text || clock_timestamp()::text),
           '0123456789abcdef',
           'a234bc56de7fgh89'
       ),
       1, 8
   )
 WHERE access_code IS NULL;

ALTER TABLE collaborators ALTER COLUMN access_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collaborators_access_code_uq ON collaborators(access_code);


-- 2. Публичные каналы коллаба на VK/MAX ─────────────────────────────────────
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS vk_url  TEXT;
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS max_url TEXT;


-- 3. Материал в базу знаний на event-уровне ─────────────────────────────────
ALTER TABLE event_collaborators ADD COLUMN IF NOT EXISTS knowledge_base_title TEXT;
ALTER TABLE event_collaborators ADD COLUMN IF NOT EXISTS knowledge_base_url   TEXT;


-- 4. Тогглы видимости полей в self-edit-форме ───────────────────────────────
ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS show_topic_field             BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS show_gift_after_speech_field BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS show_knowledge_base_field    BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
