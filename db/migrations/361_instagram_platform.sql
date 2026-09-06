-- 361: Instagram — платформа, фича и канал клиента
--
-- ПЕРВЫЙ шаг фичи «воронка Instagram»: только ПОДКЛЮЧЕНИЕ аккаунта, чтобы
-- убедиться, что связь с Meta работает. Сами воронки (комментарии под рилсами,
-- выдача материалов) — отдельной миграцией, когда подключение проверено.
-- Полный план — documentation/INSTAGRAM-FUNNEL-PLAN.md
--
-- ⚠️⚠️ Только «Instagram API with Facebook Login» (домен graph.facebook.com).
-- Проверено на прод-сервере 2026-09-03: graph.instagram.com и api.instagram.com
-- с нашего сервера НЕ отвечают (таймаут, заблокированы). Новый способ
-- «Instagram API with Instagram Login» живёт как раз на них — то есть у нас
-- он работать не будет вовсе, без зарубежного прокси.
--
-- Следствие для клиента: аккаунт обязан быть профессиональным (Бизнес/Автор)
-- и связан со страницей Facebook — иначе Meta доступ не выдаст.
--
-- ⚠️ Отдельных таблиц НЕ заводим: аккаунт ложится в существующую `channels`,
-- привязка к клиенту — через `client_channels`, как у всех остальных площадок.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Платформа
-- ─────────────────────────────────────────────────────────────────────────────
-- sort_order 5 — после whatsapp (4), перед email (50).
--
-- ⚠️ supports_video = FALSE: в директ через API видео не отправляем.
-- ⚠️ max_message_length 1000 — ограничение Instagram на сообщение в директ,
--    оно втрое короче телеграмного, и обрезка длинного текста должна
--    считаться по этому числу, а не по 4096.
INSERT INTO platforms (
    slug, display_name, color_hex, id_format,
    max_message_length, supports_buttons, supports_photo, supports_video,
    api_base_url, is_active, sort_order
)
VALUES (
    'instagram', 'Instagram', '#E1306C', 'string',
    1000, TRUE, TRUE, FALSE,
    'https://graph.facebook.com', TRUE, 5
)
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Фича — ТОЛЬКО admin
-- ─────────────────────────────────────────────────────────────────────────────
-- Клиентам не продаётся: пока не пройдена проверка Meta (App Review),
-- приложение работает только с аккаунтами, у которых есть роль в нём.
-- Открыть клиентам = добавить строку в tariff_features, без правок кода.
INSERT INTO features (slug, name, description)
VALUES (
    'instagram_funnel',
    'Воронка Instagram',
    'Ответы на комментарии под рилсами и выдача материалов в личные сообщения Instagram'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'instagram_funnel'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Где живёт подключённый аккаунт
-- ─────────────────────────────────────────────────────────────────────────────
-- Новых колонок не нужно — всё ложится в существующие поля `channels`:
--
--   platform_slug  = 'instagram'
--   handle         = @ник аккаунта
--   display_name   = имя аккаунта
--   bot_token      = long-lived access token страницы (живёт 60 дней)
--   platform_meta  = {ig_user_id, page_id, page_name, token_expires_at, scopes}
--
-- ⚠️⚠️ ТОКЕН ЖИВЁТ 60 ДНЕЙ. Без обновления воронка через два месяца молча
-- перестанет отвечать людям — не сломается заметно, а просто затихнет.
-- Поэтому `token_expires_at` в platform_meta обязателен: по нему Celery-задача
-- находит истекающие токены. Задача — следующим этапом, вместе с воронками.

COMMIT;
