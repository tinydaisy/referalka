-- 260: Привязка КАСТОМНОГО шаблона рассылки — к дню, к слоту спикера или ни к чему.
--
-- Было: у type='custom' единственный способ задать время — custom_day_ref
-- ('before_1' | 'day_N' | 'after_1') + custom_time. То есть шаблон всегда
-- «висел» на дне программы, а привязать его к выступлению конкретного спикера
-- (чтобы работали {speaker_name}, {speaker_time}, {speaker_topic} и афиша
-- спикера) было нельзя — это умеет только ручная рассылка в очереди.
--
-- Стало: явный режим привязки.
--   'day'  — как раньше: день программы (custom_day_ref) + custom_time.
--   'slot' — слот спикера (conf_sessions.id): fire_at = старт слота ± смещение,
--            в schedules пишется session_id → раскрываются спикерские плейсхолдеры.
--   'none' — без привязки: fire_at = абсолютная дата+время (custom_fire_at).
--
-- NULL = 'day' (все существующие кастомные шаблоны работают как работали).

ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS custom_bind_kind       TEXT,
  ADD COLUMN IF NOT EXISTS custom_slot_session_id INTEGER
    REFERENCES conf_sessions(id) ON DELETE SET NULL,
  -- Смещение относительно НАЧАЛА слота, в минутах. Отрицательное = раньше старта
  -- (например -5 → «за 5 минут до выступления»), положительное = позже.
  ADD COLUMN IF NOT EXISTS custom_slot_offset_min INTEGER,
  -- Абсолютная дата+время отправки для режима 'none' (локальное время клиента).
  ADD COLUMN IF NOT EXISTS custom_fire_at         TIMESTAMPTZ;

-- Бэкфилл: всё, что уже создано с днём отправки, — режим 'day'.
UPDATE broadcast_templates
   SET custom_bind_kind = 'day'
 WHERE type = 'custom' AND custom_bind_kind IS NULL;

ALTER TABLE broadcast_templates
  DROP CONSTRAINT IF EXISTS broadcast_templates_custom_bind_kind_check;
ALTER TABLE broadcast_templates
  ADD CONSTRAINT broadcast_templates_custom_bind_kind_check
  CHECK (custom_bind_kind IS NULL OR custom_bind_kind IN ('none', 'day', 'slot'));

CREATE INDEX IF NOT EXISTS idx_broadcast_templates_custom_slot
  ON broadcast_templates(custom_slot_session_id)
  WHERE custom_slot_session_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_templates TO plusson;
