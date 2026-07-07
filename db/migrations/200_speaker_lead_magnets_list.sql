-- Миграция 200: список до 4 лид-магнитов/пакетов у спикера в событии
-- Заменяет одиночную привязку event_collaborators.gift_lead_magnet_id/gift_package_id
-- на список (новая таблица). Старые колонки ОСТАВЛЯЕМ и держим в синхроне с ПЕРВОЙ
-- записью списка (для мест, которые считают одиночную привязку: medialift и т.п.).

CREATE TABLE IF NOT EXISTS event_collaborator_lead_magnets (
    id              SERIAL PRIMARY KEY,
    ec_id           INTEGER NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    lead_magnet_id  INTEGER REFERENCES lead_magnets(id) ON DELETE CASCADE,
    package_id      BIGINT  REFERENCES lead_magnet_packages(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ровно один из lead_magnet_id / package_id
    CONSTRAINT eclm_one_target CHECK (
        (lead_magnet_id IS NOT NULL)::int + (package_id IS NOT NULL)::int = 1
    )
);

CREATE INDEX IF NOT EXISTS idx_eclm_ec ON event_collaborator_lead_magnets(ec_id);

-- Перенос существующих одиночных привязок в список (sort_order=0)
INSERT INTO event_collaborator_lead_magnets (ec_id, lead_magnet_id, package_id, sort_order)
SELECT id, gift_lead_magnet_id, NULL, 0
  FROM event_collaborators
 WHERE gift_lead_magnet_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO event_collaborator_lead_magnets (ec_id, lead_magnet_id, package_id, sort_order)
SELECT id, NULL, gift_package_id, 0
  FROM event_collaborators
 WHERE gift_package_id IS NOT NULL
   AND gift_lead_magnet_id IS NULL
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_collaborator_lead_magnets TO plusson;
GRANT USAGE, SELECT ON SEQUENCE event_collaborator_lead_magnets_id_seq TO plusson;
