-- 067_features.sql (07.05.2026)
-- Справочник опций тарифа.
-- Заменяет колонку tariffs.allow_custom_bot и подобные булеаны: вместо колонки на тарифе —
-- запись в features + связь через tariff_features (миграция 068).
-- База клиента (контакты, мероприятия, рассылки) — НЕ фичи, всегда включены, в эту таблицу не попадают.

BEGIN;

CREATE TABLE IF NOT EXISTS features (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  sort        INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO features (slug, name, description, sort) VALUES
  ('lead_magnets',    'Лид-магниты',                        'Раздача материалов через бот по реферальной ссылке',           10),
  ('conference',      'Модуль Конференции',                 'Спикеры, программа, услуги, промо-партнёры, кодовые слова',     20),
  ('awards',          'Премии',                             'Модуль премий (на вырост)',                                     30),
  ('channels',        'Свои каналы (брендированный бот)',   'Подключение собственного Telegram-бота клиента',                40),
  ('export_contacts', 'Экспорт контактов',                  'Выгрузка базы контактов в CSV',                                 50)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
