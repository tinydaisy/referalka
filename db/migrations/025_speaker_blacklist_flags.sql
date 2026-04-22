-- Миграция 025: два флага «чёрного списка» для спикера в событии
-- exclude_gift_from_broadcast — подарок спикера не включается в общую рассылку
-- exclude_channel_from_subscription — канал спикера не проверяется на подписку

ALTER TABLE conf_speaker_events
    ADD COLUMN IF NOT EXISTS exclude_gift_from_broadcast      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS exclude_channel_from_subscription BOOLEAN NOT NULL DEFAULT FALSE;
