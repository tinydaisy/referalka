-- ═══════════════════════════════════════════
-- PLUSSON — Начальные данные (seed)
-- ═══════════════════════════════════════════

-- Модули платформы
INSERT INTO modules (slug, name, description) VALUES
  ('base',       'Базовый',     'Только вкладка [Игра] — реферальный движок'),
  ('conference', 'Конференция', 'Вкладки [Программа] [Розыгрыш] [Услуги]'),
  ('webinar',    'Вебинар',     'Вкладки [Программа] [Запись]'),
  ('training',   'Тренинг',     'Вкладки [Программа] [Задания] [Материалы]'),
  ('promo',      'Промо-акция', 'Вкладки [Призы] [Лидерборд]')
ON CONFLICT (slug) DO NOTHING;

-- Тарифы — в MVP один: бесплатный Beta
INSERT INTO tariffs (slug, name, price, trial_months, max_events, max_participants) VALUES
  ('beta', 'Бесплатный (Beta)', 0.00, 12, -1, -1)
ON CONFLICT (slug) DO NOTHING;

-- Клиент: Маргарита Владимировна
-- Пароль устанавливается через /api/v1/auth/set-password после первого входа
INSERT INTO clients (name, email, phone, telegram_username, tariff_slug, trial_ends_at, is_active)
VALUES (
  'Маргарита Владимировна',
  'margarita.vl2011@gmail.com',
  '79931354897',
  'margo_forbs',
  'beta',
  NOW() + INTERVAL '12 months',
  TRUE
)
ON CONFLICT (email) DO NOTHING;

-- Подключаем модули клиенту (id=1 — первый клиент)
INSERT INTO client_modules (client_id, module_slug)
SELECT c.id, m.slug
FROM clients c, modules m
WHERE c.email = 'margarita.vl2011@gmail.com'
  AND m.slug IN ('base', 'conference')
ON CONFLICT (client_id, module_slug) DO NOTHING;
