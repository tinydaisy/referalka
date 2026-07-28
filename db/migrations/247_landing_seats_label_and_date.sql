-- 247: Подпись счётчика мест и дата в шапке лендинга (миграции 240-246).
--
-- 1. ПОДПИСЬ СЧЁТЧИКА МЕСТ (`events.seats_label` + `seats_label_position`)
--    Раньше подпись брали из заголовка блока «Осталось мест», а число мест
--    задавалось отдельно сверху страницы — две связанные настройки в разных
--    местах. Теперь текст лежит рядом с числом мест (на событии), а положение
--    относительно рамки с цифрой выбирается: сверху / слева / справа.
--
-- 2. ДАТА В ШАПКЕ (`event_landing_blocks.show_date` + `date_position`)
--    Дата события в шапке была всегда и жёстко над заголовком. Теперь её
--    можно выключить и поставить над заголовком либо под подзаголовком.
--    Цвет — основного текста страницы (не фирменный акцент).

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS seats_label TEXT,
  ADD COLUMN IF NOT EXISTS seats_label_position TEXT NOT NULL DEFAULT 'top'
        CHECK (seats_label_position IN ('top', 'left', 'right'));

COMMENT ON COLUMN events.seats_label IS
  'Подпись счётчика мест на лендинге («Осталось мест:»). Пусто — подписи нет.';

ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS show_date     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS date_position TEXT NOT NULL DEFAULT 'above'
        CHECK (date_position IN ('above', 'below'));

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
