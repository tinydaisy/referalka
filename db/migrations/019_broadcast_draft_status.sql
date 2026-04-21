-- Миграция 019: статус draft для рассылок до запуска очереди
-- Статусы: draft (черновик) | pending (в очереди Celery) | running (отправляется) | done (отправлено) | cancelled (отменена)
-- Новые записи создаются со статусом 'draft'. run-all переводит draft -> pending.
COMMENT ON COLUMN broadcast_schedules.status IS 'draft|pending|running|done|cancelled';
