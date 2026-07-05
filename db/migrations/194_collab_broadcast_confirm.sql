-- Миграция 194: рассылки v1 для коллаб-события — подтверждение постановки в чужую базу
-- ─────────────────────────────────────────────────────────────
-- Коллаб-событие: организаторы равноправны. Каждый ставит рассылку по СВОЕЙ базе
-- (свой VIP-бот, своя реф-ссылка) — встаёт в очередь сразу. Если инициатор ставит
-- галочку «запросить подтверждение по базам соорганизаторов» — каждому ДРУГОМУ
-- организатору создаётся КОПИЯ рассылки со статусом 'awaiting_confirm'. Он
-- подтверждает → его копия переходит в 'pending' и уходит по ЕГО базе; отклоняет
-- → 'cancelled'. Пакет (серия/из программы) = ОДНО подтверждение на весь пакет
-- (группировка по confirm_batch_id).
--
-- Планировщик берёт строго status='pending' (tasks/broadcast.py), поэтому
-- 'awaiting_confirm' Celery НЕ подхватывает автоматически — доп. фильтр не нужен.

ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS confirm_batch_id UUID,          -- пакет: 1 подтверждение на всю серию
    ADD COLUMN IF NOT EXISTS origin_client_id INTEGER;       -- кто инициировал рассылку (для «от кого запрос»)

-- Быстрый поиск ожидающих подтверждения копий пакета у конкретного клиента.
CREATE INDEX IF NOT EXISTS idx_bcast_confirm_batch
    ON broadcast_schedules (confirm_batch_id)
    WHERE confirm_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bcast_awaiting
    ON broadcast_schedules (client_id, status)
    WHERE status = 'awaiting_confirm';

COMMENT ON COLUMN broadcast_schedules.status IS
    'draft|pending|running|done|cancelled|awaiting_confirm';
