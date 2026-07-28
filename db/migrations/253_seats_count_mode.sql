-- 253: Счётчик мест — что считать и с какого числа (лендинг, миграции 240-252).
--
-- Зачем.
--   seats_count_mode — считать занятые места по РЕГИСТРАЦИЯМ (как было) или
--                      по ЗАХОДАМ (все, кто открыл событие, включая тех, кто
--                      до регистрации не дошёл). Организатору иногда важнее
--                      показать интерес, а не только подтверждённые записи.
--   seats_base       — стартовое смещение. У клиента уже есть аудитория
--                      (например, 1100 человек в чате), и счётчик должен
--                      идти от неё: 1100 + число пришедших из бота.
--
-- Оба поля необязательные: пусто → прежнее поведение (по регистрациям, с нуля).

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS seats_count_mode TEXT NOT NULL DEFAULT 'registered'
    CHECK (seats_count_mode IN ('registered', 'visited')),
  ADD COLUMN IF NOT EXISTS seats_base INT;

GRANT SELECT, INSERT, UPDATE, DELETE ON events TO plusson;
