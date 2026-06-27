-- Миграция 176: два уровня доступа к «Чатам для рассылок».
--
-- Раньше вся фича client_broadcast_chats была залочена под единственную фичу
-- `broadcast_chats` (тариф Экстра 2990). По требованию — разбить на два уровня:
--   • broadcast_chats_one  — «по одному чату на площадку» (1 TG + 1 VK + 1 MAX) → тариф Профи (pro, 1990).
--   • broadcast_chats      — «неограниченно чатов»                              → тариф Экстра (vip, 2990).
--
-- Старая фича broadcast_chats остаётся СЕМАНТИКОЙ БЕЗЛИМИТА (уже привязана к vip/admin —
-- не трогаем). Добавляем новую broadcast_chats_one и вешаем её на pro.
-- Лимит «1 на площадку» проверяется в коде (backend/app/api/client_broadcast_chats.py),
-- не в БД — чтобы не плодить триггеры.

-- 1) Новая фича «по одному чату на площадку».
INSERT INTO features (slug, name, description, sort)
VALUES (
    'broadcast_chats_one',
    'Чаты для рассылок (по одному)',
    'По одному внешнему чату/группе на каждую площадку (1 Telegram + 1 VK + 1 MAX) для дополнительных рассылок.',
    13
)
ON CONFLICT (slug) DO NOTHING;

-- 2) Привязать broadcast_chats_one к тарифу Профи (pro, 1990).
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'pro' AND f.slug = 'broadcast_chats_one'
ON CONFLICT DO NOTHING;

-- 3) Профи (pro) НЕ должен иметь безлимитную broadcast_chats — у него только _one.
--    (vip/admin сохраняют безлимитную broadcast_chats — их не трогаем.)
DELETE FROM tariff_features tf
 USING tariffs t, features f
 WHERE tf.tariff_id = t.id AND tf.feature_id = f.id
   AND t.slug = 'pro' AND f.slug = 'broadcast_chats';

-- 4) Тарифу Экстра (vip) на всякий случай добавить и broadcast_chats_one,
--    чтобы клиент с безлимитом гарантированно проходил и проверку «есть доступ к разделу»
--    (вкладка видна при любой из двух фич). Безлимит всё равно перебивает лимит в коде.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug IN ('vip','admin') AND f.slug = 'broadcast_chats_one'
ON CONFLICT DO NOTHING;
