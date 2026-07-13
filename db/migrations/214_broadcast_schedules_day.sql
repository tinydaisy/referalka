-- 214: явный «день программы» у рассылки.
--
-- Проблема. Дневные рассылки (2h_before_*, 30min_before, day_live, day_end,
-- day_before_09_12_*) подставляют программу дня. Номер дня определялся ТОЛЬКО
-- по дате fire_at: искали conf_days с day_date = дата отправки. Для «за 2 часа»
-- и «за 30 минут» это совпадает, но для «за сутки» (день_before_09_12_*) дата
-- отправки — НАКАНУНЕ, такого дня в conf_days нет → день молча падал в 1, и в
-- письмо уезжала программа первого дня вместо нужного.
--
-- Селектор «День конференции» в модалке «Добавить рассылку вручную» уже был,
-- но бэкенд поле выбрасывал — хранить его было негде.
--
-- Теперь день можно задать ЯВНО. Приоритет в message_builder:
--   broadcast_schedules.day (если задан) > вычисление по дате fire_at.
-- NULL = старое поведение (день по дате) — совместимость со всеми записями.
ALTER TABLE broadcast_schedules ADD COLUMN IF NOT EXISTS day INTEGER NULL;

COMMENT ON COLUMN broadcast_schedules.day IS
  'Номер дня программы (conf_days.day_number), к которому привязана дневная рассылка. NULL = определять по дате fire_at.';

-- Бэкфилл: у уже созданных дневных рассылок день совпадает с датой отправки
-- (так работал старый резолв) — фиксируем его явно, чтобы поведение не поехало,
-- если кто-то потом поправит дату вручную.
UPDATE broadcast_schedules bs
   SET day = cd.day_number
  FROM conf_days cd
 WHERE bs.day IS NULL
   AND bs.fire_at IS NOT NULL
   AND cd.event_id = bs.event_id
   AND cd.day_date = (bs.fire_at AT TIME ZONE 'Europe/Moscow')::date
   AND bs.type IN ('2h_before_unreg', '2h_before_reg', '30min_before',
                   'day_live', 'day_end',
                   'day_before_09_12_unreg', 'day_before_09_12_reg');
