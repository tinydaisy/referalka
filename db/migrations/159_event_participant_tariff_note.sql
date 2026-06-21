-- Миграция 159: заметка к записи оплаты/заказа тарифа.
-- Зачем. Организатор хочет хранить комментарий по каждому человеку в оплатах
-- (например «от партнёра Михайленко, жду 3000р», «50 на 50»).

ALTER TABLE event_participant_tariffs
  ADD COLUMN IF NOT EXISTS note TEXT;
COMMENT ON COLUMN event_participant_tariffs.note IS 'Заметка организатора к этой записи оплаты/заказа (видна только в дашборде).';
