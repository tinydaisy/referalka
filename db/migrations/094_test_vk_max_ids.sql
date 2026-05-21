-- Миграция 094: тестовые ID для VK и MAX
--
-- До этой миграции тестовые рассылки (кнопка «Тест» в шаблонах рассылок)
-- работали только в Telegram через clients.test_telegram_ids TEXT[].
-- Теперь у клиента может быть свой массив тестовых VK ID и MAX ID,
-- чтобы посмотреть как письмо выглядит во всех трёх мессенджерах.
--
-- Формат: массив строк (как у test_telegram_ids).
-- - test_vk_ids — числовые VK user_id (например, '123456789'). Резолв
--   screen_name → vk_id не делаем — пользователь сам берёт ID из
--   профиля или vk.com/id... Тестовый аккаунт должен быть подписан
--   на VK-сообщество клиента (или системное iViSiON: ПЛЮСОН), иначе
--   VK API вернёт «message_deny» — на UI это видно в результатах.
-- - test_max_ids — MAX user_id (строкой, как тестовые TG).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS test_vk_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS test_max_ids TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN clients.test_vk_ids IS 'Массив VK user_id для тестовых рассылок (numeric строки)';
COMMENT ON COLUMN clients.test_max_ids IS 'Массив MAX user_id для тестовых рассылок (numeric строки)';
