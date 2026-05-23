-- 104_email_unsubscribe_reason.sql (2026-05-23)
--
-- При отписке от email теперь спрашиваем причину (радио-кнопки «слишком много
-- писем», «не интересен контент» и т.п.) + опциональный комментарий. Сохраняем
-- их в email_unsubscribe_log — для аналитики «почему уходят» и улучшения
-- контента рассылок клиентом.

ALTER TABLE email_unsubscribe_log
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS reason_comment TEXT;
