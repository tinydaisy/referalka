-- 167: Привязка спикера к его аккаунту ПЛЮСОН + лид-магнит/пакет как «подарок после эфира»
--
-- Стратегия: спикеры чемпионата становятся клиентами ПЛЮСОН (воронка в сервис).
-- Спикер из своего кабинета подключает свой ПЛЮСОН-аккаунт (через попап-логин),
-- затем выбирает СВОЙ лид-магнит/пакет как подарок. Турнирный критерий
-- auto_kind='lead_magnet' считает COUNT(funnel_runs) по этому магниту/пакету.

-- Связка спикер↔его кабинет ПЛЮСОН. Глобально на коллабораторе (один раз подключил —
-- действует на всех событиях, где он спикер).
ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS linked_client_id INTEGER NULL
    REFERENCES clients(id) ON DELETE SET NULL;

-- Конкретный подарок-лид-магнит на событие (из лид-магнитов linked_client_id).
-- Заполнено максимум одно из двух.
ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS gift_lead_magnet_id INTEGER NULL
    REFERENCES lead_magnets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gift_package_id BIGINT NULL
    REFERENCES lead_magnet_packages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_collaborators_linked_client
  ON collaborators(linked_client_id) WHERE linked_client_id IS NOT NULL;
