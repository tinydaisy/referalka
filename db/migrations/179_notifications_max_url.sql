-- 179: сохранять ССЫЛКУ на MAX-канал уведомлений (чтобы оставалась в поле после
-- сохранения, рядом с chat_id). Раньше ссылка была временным полем во фронте и
-- пропадала после перезагрузки — пользователю казалось, что не сохранилось.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS notifications_max_url TEXT NULL;

COMMENT ON COLUMN clients.notifications_max_url IS 'Ссылка на MAX-канал уведомлений (для отображения в форме рядом с notifications_max_chat_id).';
