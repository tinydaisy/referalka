-- Миграция 193: автозапись истории коллабораций (рейтинг Коллабораторной)
-- ─────────────────────────────────────────────────────────────
-- Рейтинг/Win-Win-коэффициент партнёра СЧИТАЮТСЯ из hub_collab_history,
-- но раньше НИКАКОЙ код туда не писал (наполнялось только вручную для демо).
-- Теперь при завершении коллаб-события (status→ended) сервис
-- record_collab_history пишет по строке на каждого организатора.
--
-- UNIQUE(client_id, event_id) — идемпотентность: повторный PATCH события
-- в ended не плодит дубли, а обновляет вклад (UPSERT).
-- Демо-строки (event_id NULL) не конфликтуют — частичный индекс только по не-NULL event_id.

CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_history_client_event
    ON hub_collab_history (client_id, event_id)
    WHERE event_id IS NOT NULL;
