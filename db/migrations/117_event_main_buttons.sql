-- 117_event_main_buttons.sql
-- 2026-05-26
--
-- «Главные кнопки» события в Mini App — заголовок «Чат события» и выбор
-- акцентной (красной) кнопки. До этой миграции:
--   • VIP-кнопка всегда красная (хардкод-градиент в VipButton.tsx)
--   • Чат всегда тёмно-синий, заголовок «Чат события» хардкод в Program/Turnir/Contest
--
-- Что добавляет:
--   • events.chat_button_label TEXT NULL — текст заголовка кнопки чата.
--     NULL = дефолт «Чат события».
--   • events.accent_button TEXT NULL — какая кнопка красная: 'vip'|'chat'|'none'.
--     NULL = 'vip' (текущее поведение, обратная совместимость без бэкфилла).
--
-- Подпись под заголовком чата уже была редактируема через
-- events.chat_member_count_label — не трогаем.

BEGIN;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS chat_button_label TEXT,
  ADD COLUMN IF NOT EXISTS accent_button     TEXT;

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_accent_button_check;

ALTER TABLE events
  ADD CONSTRAINT events_accent_button_check
  CHECK (accent_button IS NULL OR accent_button IN ('vip', 'chat', 'none'));

COMMIT;
