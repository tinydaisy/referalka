-- 262: Как идёт регистрация на событие — явный выбор (миграции 240-261).
--
-- Было: способ определялся косвенно, по заполненности events.landing_url —
-- пусто значит встроенная форма, заполнено значит чужой сайт. Собранный в
-- конструкторе лендинг (pluson.ru/e/{slug}) в эту схему не помещался вовсе:
-- выбрать его было нечем, хотя страница уже опубликована.
--
-- Стало: три способа явно.
--   'form'     — встроенная форма на простой странице события (как было);
--   'landing'  — редирект на наш лендинг pluson.ru/e/{slug};
--   'external' — редирект на сторонний сайт (events.landing_url).
--
-- NULL трактуем как раньше: есть landing_url → 'external', иначе 'form'.
-- Так существующие события работают без изменений.

-- landing_require_registration — нужна ли регистрация на нашем лендинге.
-- FALSE: человек с лендинга сразу платит или уходит в бота, форму не
-- показываем (у бесплатного тарифа регистрируем по аккаунту).
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS registration_mode TEXT
    CHECK (registration_mode IN ('form', 'landing', 'external')),
  ADD COLUMN IF NOT EXISTS landing_require_registration BOOLEAN NOT NULL DEFAULT TRUE;

GRANT SELECT, INSERT, UPDATE, DELETE ON events TO plusson;
