-- 090_system_max_channel.sql
-- Создаёт системный MAX-канал ПЛЮСОНа (бот @id890306512862_1_bot,
-- user_id=272236309, имя «ПЛЮСОН-СЕРВИС») и автоматически выдаёт
-- к нему доступ всем существующим клиентам через client_channels.
--
-- Аналог того, что вручную сделали для VK (channels с is_system=TRUE).
-- bot_token в БД пустой — реальный токен живёт в .env как
-- MAX_SYSTEM_BOT_TOKEN и подтягивается в runtime для системных каналов.
--
-- is_test=TRUE — пока канал в тестовом режиме, новым клиентам не
-- проксируется автоматически. После проверки на проде поменяем на
-- FALSE через /admin/system-channels (там же backfill всем клиентам).

INSERT INTO channels (
    platform_slug, display_name, handle, bot_token,
    is_system, is_test, platform_meta
)
VALUES (
    'max',
    'iViSiON: ПЛЮСОН (MAX)',
    'id890306512862_1_bot',
    '',
    TRUE,
    TRUE,
    jsonb_build_object(
        'max_user_id', 272236309,
        'max_bot_name', 'ПЛЮСОН-СЕРВИС'
    )
)
ON CONFLICT DO NOTHING;

-- Привязываем системный MAX-канал ко всем существующим клиентам.
-- is_active=FALSE — клиент пока не активирует у себя автоматически,
-- появится в списке «Каналы» как доступный для активации.
INSERT INTO client_channels (client_id, channel_id, is_active)
SELECT c.id, ch.id, FALSE
FROM clients c
CROSS JOIN channels ch
WHERE ch.platform_slug = 'max'
  AND ch.is_system = TRUE
  AND ch.handle = 'id890306512862_1_bot'
ON CONFLICT (client_id, channel_id) DO NOTHING;
