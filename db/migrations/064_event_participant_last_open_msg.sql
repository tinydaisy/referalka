-- Миграция 064: запоминаем какое именно «открыл-событие» сообщение бот
-- последним отправил каждому участнику — чтобы не дублировать его при
-- повторных входах в Mini App.
--
-- last_open_msg_kind:
--   'register_cta'      — не зареган, событие активно
--   'referral_reminder' — зареган, событие не завершилось
--   'next_event_cta'    — событие завершилось, есть successor
--   'ecosystem_thanks'  — событие завершилось, успешник не задан
--
-- Дедуп при event_start:
--   1) если новый kind ≠ last_open_msg_kind — шлём (статус сменился);
--   2) если совпадает, но в broadcast_log есть отправки участнику ПОСЛЕ
--      last_open_msg_at — наше сообщение уехало вверх, шлём заново;
--   3) иначе — пропускаем.
--
-- 2026-05-05

ALTER TABLE event_participants
  ADD COLUMN IF NOT EXISTS last_open_msg_kind TEXT,
  ADD COLUMN IF NOT EXISTS last_open_msg_at   TIMESTAMPTZ;
