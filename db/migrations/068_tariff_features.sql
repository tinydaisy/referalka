-- 068_tariff_features.sql (07.05.2026)
-- Junction many-to-many: какие фичи входят в какой тариф.
-- Сидинг связей — в миграции 071 (после создания всех новых тарифов).

BEGIN;

CREATE TABLE IF NOT EXISTS tariff_features (
  tariff_id  INTEGER NOT NULL REFERENCES tariffs(id)  ON DELETE CASCADE,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  PRIMARY KEY (tariff_id, feature_id)
);

CREATE INDEX IF NOT EXISTS idx_tariff_features_feature ON tariff_features(feature_id);

COMMIT;
