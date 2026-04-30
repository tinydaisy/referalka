-- ═══════════════════════════════════════════
-- Миграция 052: Разделение визитки на «Бренд» и «Основатель»
--
-- Что добавляет в clients:
--   1. brand_logo_url       — логотип бренда (для угла страниц Mini App)
--   2. owner_name           — имя основателя (отдельно от технического clients.name)
--   3. owner_photo_url      — фото основателя
--   4. owner_positioning    — позиционирование основателя
--   5. owner_achievements   — Факты в цифрах основателя (JSONB, [{label,value}×N])
--
-- Существующие поля (после 039+042) переосмысливаются как «бренд»:
--   • brand_name           — название бренда
--   • profile_photo_url    — фото бренда
--   • positioning          — позиционирование бренда
--   • achievements         — Факты в цифрах бренда
--   • social_links         — соцсети основателя (бренд без соцсетей в MVP)
--   • bio                  — биография основателя
--
-- Используется:
--   • Mini App: логотип в углу всех страниц события + Хаба
--   • Mini App: шапка Экосистемы (бренд) + карточка-тизер «Об основателе» → отдельная страница
--   • Web: /dashboard/mini-app — две вкладки «Бренд» / «Основатель»
-- ═══════════════════════════════════════════

BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS brand_logo_url     TEXT,
  ADD COLUMN IF NOT EXISTS owner_name         TEXT,
  ADD COLUMN IF NOT EXISTS owner_photo_url    TEXT,
  ADD COLUMN IF NOT EXISTS owner_positioning  TEXT,
  ADD COLUMN IF NOT EXISTS owner_achievements JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN clients.brand_logo_url     IS 'Логотип бренда (R2 url). Показывается в правом углу всех страниц Mini App.';
COMMENT ON COLUMN clients.owner_name         IS 'Имя основателя для Mini App (отдельно от технического clients.name из регистрации).';
COMMENT ON COLUMN clients.owner_photo_url    IS 'Фото основателя (R2 url) для страницы «Об основателе» и карточки-тизера.';
COMMENT ON COLUMN clients.owner_positioning  IS 'Позиционирование основателя одной строкой.';
COMMENT ON COLUMN clients.owner_achievements IS 'Факты в цифрах основателя: [{label,value}]. Скрываются если пусто.';

-- Переосмысливаем существующие комментарии (без изменения данных)
COMMENT ON COLUMN clients.profile_photo_url IS 'Фото БРЕНДА (R2 url) для шапки Экосистемы Mini App.';
COMMENT ON COLUMN clients.positioning       IS 'Позиционирование БРЕНДА одной строкой.';
COMMENT ON COLUMN clients.achievements      IS 'Факты в цифрах БРЕНДА: [{label,value}]. Скрываются если пусто.';
COMMENT ON COLUMN clients.bio               IS 'Биография ОСНОВАТЕЛЯ для страницы «Об основателе» в Mini App.';
COMMENT ON COLUMN clients.social_links      IS 'Соцсети ОСНОВАТЕЛЯ: {instagram, telegram, youtube, vk, website}. В MVP бренд без соцсетей.';

COMMIT;
