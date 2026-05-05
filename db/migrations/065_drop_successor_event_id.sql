-- Миграция 065: убираем events.successor_event_id.
--
-- Поле было задумано как ручная per-event ссылка «какое событие предлагать
-- после завершения текущего» (миграция 039). На практике клиенты его
-- никогда не заполняли. Логика «а дальше у нас…» теперь полностью
-- автоматическая — ближайшее предстоящее опубликованное событие того же
-- клиента (см. backend/app/api/client_profile.py и
-- backend/app/services/event_welcome.py). Колонка лишняя.
--
-- 2026-05-05

DROP INDEX IF EXISTS idx_events_successor;

ALTER TABLE events DROP COLUMN IF EXISTS successor_event_id;
