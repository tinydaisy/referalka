-- 195: Настройка «что показывать при завершении события» (вкладка Итоги в Mini App).
-- Выбор клиента: показывать следующее (незавершённое) событие ИЛИ подарок (лид-магнит/пакет).
-- end_action: 'next_event' (default, как было) | 'gift'.
-- При 'gift' — подарок берётся из лид-магнита ИЛИ пакета (взаимоисключающе).

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS end_action TEXT NOT NULL DEFAULT 'next_event',
    ADD COLUMN IF NOT EXISTS end_gift_lead_magnet_id INTEGER
        REFERENCES lead_magnets(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS end_gift_package_id BIGINT
        REFERENCES lead_magnet_packages(id) ON DELETE SET NULL;

-- Допустимые значения end_action
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_end_action_chk;
ALTER TABLE events ADD CONSTRAINT events_end_action_chk
    CHECK (end_action IN ('next_event', 'gift'));
