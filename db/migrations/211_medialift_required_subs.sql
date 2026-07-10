-- Миграция 211: сколько каналов обязательно подписать в МедиаЛифте — свойство события.
--
-- Раньше число обязательных подписок было захардкожено (MIN_SUBSCRIBE=3) в коде
-- воронки. Делаем настраиваемым на уровне события Mini App: организатор задаёт его
-- в общих настройках события МедиаЛифт.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS medialift_required_subscriptions INTEGER NOT NULL DEFAULT 3
    CHECK (medialift_required_subscriptions BETWEEN 1 AND 7);

COMMENT ON COLUMN events.medialift_required_subscriptions IS
  'МедиаЛифт: сколько каналов из ветки участник обязан подписать перед входом (1..7). По умолчанию 3.';
