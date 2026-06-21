-- Миграция 158: статус заказа тарифа — «имеет заказ, не оплатил» vs «оплатил».
--
-- Зачем. До этого запись в event_participant_tariffs = факт оплаты. Теперь
-- платёжка может прислать вебхук «создан заказ» (до оплаты). Нужно различать
-- «имеет заказ, не оплатил» (unpaid) и «оплатил» (paid).

ALTER TABLE event_participant_tariffs
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'paid';

ALTER TABLE event_participant_tariffs
  DROP CONSTRAINT IF EXISTS event_participant_tariffs_status_chk;
ALTER TABLE event_participant_tariffs
  ADD CONSTRAINT event_participant_tariffs_status_chk
  CHECK (status IN ('unpaid', 'paid'));

COMMENT ON COLUMN event_participant_tariffs.status IS 'unpaid — имеет заказ, не оплатил; paid — оплатил. Существующие записи = paid.';

-- ordered_at — когда заказ создан (для аналитики «висящих» заказов).
ALTER TABLE event_participant_tariffs
  ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ;
COMMENT ON COLUMN event_participant_tariffs.ordered_at IS 'Когда создан заказ (вебхук unpaid). NULL у старых оплат.';
