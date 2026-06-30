-- 183: миграция 180 добавила режим /start = 'lead_magnet', но CHECK-констрейнт
-- из 169 разрешал только ('greeting','event') → при выборе лид-магнита БД падала
-- (clients_start_mode_chk). Расширяем констрейнт.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_start_mode_chk;
ALTER TABLE clients
  ADD CONSTRAINT clients_start_mode_chk
  CHECK (start_mode IN ('greeting', 'event', 'lead_magnet'));
