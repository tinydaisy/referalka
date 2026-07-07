-- 198: Платформа WhatsApp как канал доставки.
--
-- WhatsApp работает не через bot_token (как TG/VK/MAX), а через whatsapp-web.js мост:
-- клиент привязывает свой аккаунт по QR, сессия живёт на мосту (сессия на client_id).
-- В channels WhatsApp-канал хранит привязку в platform_meta (без bot_token).
--
-- Здесь: регистрируем платформу в справочнике + разрешаем whatsapp-чаты в базе рассылок.

-- 1. Платформа в справочник
INSERT INTO platforms (slug, display_name, id_format, max_message_length, supports_buttons, supports_photo, supports_video, is_active, sort_order)
VALUES ('whatsapp', 'WhatsApp', 'text', 65536, FALSE, TRUE, TRUE, TRUE, 4)
ON CONFLICT (slug) DO NOTHING;

-- 2. Разрешить платформу 'whatsapp' в чатах для рассылок
ALTER TABLE client_broadcast_chats DROP CONSTRAINT IF EXISTS client_broadcast_chats_platform_chk;
ALTER TABLE client_broadcast_chats ADD CONSTRAINT client_broadcast_chats_platform_chk
  CHECK (platform IN ('telegram', 'vk', 'max', 'whatsapp'));
