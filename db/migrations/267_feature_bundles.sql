-- 267. Модуль может приносить с собой другие фичи («вложенные фичи»).
--
-- Зачем. `client_addons` хранит ОДНУ строку «клиент купил модуль X» и выдаёт
-- ровно фичу X. Механизма «модуль включает в себя ещё и другие возможности»
-- не было. Из-за этого нельзя было выдать покупателям Коллабораторной
-- безлимитные чаты рассылок (`broadcast_chats`), не отдав их заодно ВСЕМ на
-- тарифе Профи — а это стёрло бы разницу между Профи и Экстра.
--
-- Теперь: `collab_hub` → включает `broadcast_chats`. Купил Коллабораторную —
-- получил безлимит чатов; модуль истёк — вернулся лимит своего тарифа.
--
-- ⚠️ Разворот вложенных фич — ОДИН уровень, без рекурсии: фича, выданная
-- через bundle, сама bundle не разворачивает. Так нельзя случайно построить
-- цепочку A→B→C (и зациклить её), а на практике одного уровня хватает.

CREATE TABLE IF NOT EXISTS feature_bundles (
    id                  SERIAL PRIMARY KEY,
    feature_id          INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    included_feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT feature_bundles_uniq UNIQUE (feature_id, included_feature_id),
    -- Фича не может включать саму себя: это бессмысленно и ломает разворот.
    CONSTRAINT feature_bundles_not_self CHECK (feature_id <> included_feature_id)
);

COMMENT ON TABLE feature_bundles IS
    'Какие ДОПОЛНИТЕЛЬНЫЕ фичи приносит с собой фича-модуль (один уровень вложенности)';

CREATE INDEX IF NOT EXISTS feature_bundles_feature_idx
    ON feature_bundles (feature_id);

-- Коллабораторная даёт безлимитные чаты для рассылок.
INSERT INTO feature_bundles (feature_id, included_feature_id)
SELECT f.id, i.id
  FROM features f, features i
 WHERE f.slug = 'collab_hub' AND i.slug = 'broadcast_chats'
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON feature_bundles TO plusson;
GRANT USAGE, SELECT ON SEQUENCE feature_bundles_id_seq TO plusson;
