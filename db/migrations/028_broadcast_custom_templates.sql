-- 028: поддержка кастомных шаблонов рассылок
-- Шаблон типа 'custom' — клиент задаёт дату относительно дней конференции и время.
-- custom_day_ref: 'before_N' | 'day_N' | 'after_N'
--   before_N — за N дней до первого дня конференции
--   day_N    — в день номер N (по conf_days.day_number)
--   after_N  — через N дней после последнего дня конференции
-- custom_time: время отправки в таймзоне клиента, формат 'HH:MM'

ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS custom_day_ref TEXT,
  ADD COLUMN IF NOT EXISTS custom_time    TEXT;
