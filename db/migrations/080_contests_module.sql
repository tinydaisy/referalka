-- Миграция 080: новый тип события «Участие в конкурсах» (module_slug='contest').
--
-- Кейс: клиент сам участвует в стороннем конкурсе/премии/голосовании, где нужно
-- призывать аудиторию голосовать за себя. У события нет соорганизаторов,
-- внешнего лендинга и VIP-тарифа. Ссылка «голосования» вместо ZOOM, чат
-- «голосующих и партнёров» вместо чата участников, вкладка «Голосующие»
-- вместо «Участники». В Mini App в программе показывается описание события
-- + кнопка «Перейти к голосованию».
--
-- Архитектура: новый module в `modules` + отдельная фича `contests` в features
-- + бинды в tariff_features для всех 4 тарифов (trial/start/pro/vip).
-- Минимальный платный тариф (start) уже получает доступ.
--
-- Существующие клиенты автоматически получают фичу через свой текущий тариф
-- (она лежит на уровне tariffs, не client). Никакой per-client миграции.

BEGIN;

-- 1. Новый модуль
INSERT INTO modules (slug, name, description) VALUES
  ('contest', 'Участие в конкурсах', 'Клиент сам участвует в конкурсе и призывает голосовать за себя')
ON CONFLICT (slug) DO NOTHING;

-- 2. Новая фича
INSERT INTO features (slug, name, description, sort) VALUES
  ('contests', 'Участие в конкурсах', 'Тип события для сбора голосов в стороннем конкурсе', 60)
ON CONFLICT (slug) DO NOTHING;

-- 3. Привязка ко всем тарифам (минимальный платный = start)
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE f.slug = 'contests'
   AND t.slug IN ('trial', 'start', 'pro', 'vip')
ON CONFLICT (tariff_id, feature_id) DO NOTHING;

COMMIT;
