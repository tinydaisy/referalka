-- 177: числовые ID каналов коллаба для VK и MAX (для реальной проверки подписки)
--
-- Зачем. При входе в чат события проверяем подписку участника на каналы
-- организаторов/спикеров. Для Telegram это работает через collaborators.tg_channel_id
-- (числовой id канала) + getChatMember. Для VK и MAX числового id у коллаба не было.
--   • VK  — резолвится автоматически из vk_url через utils.resolveScreenName (как
--           vk_group_id у клиента), но кешируем в колонку, чтобы не дёргать API каждый раз.
--   • MAX — публичного резолва по ссылке нет, id вводится вручную (как chat_id у
--           каналов основателя в social_links.max_channels). Бот должен быть админом канала.
--
-- Проверка членства:
--   VK  — groups.isMember(vk_channel_id, user_id)  (services/vk_api.is_user_member_of_group)
--   MAX — GET /chats/{max_channel_id}/members?user_ids=<id> (services/max_api.check_channel_membership)

ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS vk_channel_id  TEXT NULL;
ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS max_channel_id TEXT NULL;

COMMENT ON COLUMN collaborators.vk_channel_id  IS 'Числовой id VK-сообщества коллаба (резолв из vk_url) — для groups.isMember при проверке подписки на чат события';
COMMENT ON COLUMN collaborators.max_channel_id IS 'Числовой id MAX-канала коллаба (вводится вручную, бот должен быть админом) — для проверки подписки на чат события';
