-- 145: контакты службы поддержки по платформам (TG / VK / MAX)
-- Раньше был один work_tg_username (TG, @username). Теперь у клиента три
-- контакта для связи — по одному на платформу. Каждая воронка (лид-магнит,
-- событие, nurture) подставляет {support_link} своей платформы; если контакта
-- нужной платформы нет — подставляется первый имеющийся.
-- TG теперь хранится ПОЛНОЙ ССЫЛКОЙ (https://t.me/...), не @username.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS work_vk  TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS work_max TEXT;

-- work_tg_username переиспользуется под TG-контакт (теперь полная ссылка).
COMMENT ON COLUMN clients.work_tg_username IS 'Контакт поддержки TG — полная ссылка https://t.me/...';
COMMENT ON COLUMN clients.work_vk  IS 'Контакт поддержки VK — полная ссылка';
COMMENT ON COLUMN clients.work_max IS 'Контакт поддержки MAX — полная ссылка';
