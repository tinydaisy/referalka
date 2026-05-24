-- 109_speaker_link_clicks.sql
-- 2026-05-24
--
-- Учёт кликов участников по ссылкам в карточке спикера в Mini App.
-- Что трекаем: какие участники нажали на ТГ-канал спикера, ВК, MAX,
-- Instagram, сайт, материал в базу знаний. Используется для статистики
-- в дашборде клиента и в отчёте конференции (по каждому коллабу).

BEGIN;

CREATE TABLE IF NOT EXISTS event_collaborator_clicks (
    id                    BIGSERIAL PRIMARY KEY,
    event_collaborator_id INT NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    contact_id            INT REFERENCES contacts(id) ON DELETE SET NULL,
    click_kind            TEXT NOT NULL CHECK (click_kind IN (
        'tg_channel', 'vk', 'max', 'instagram', 'website', 'knowledge_base'
    )),
    clicked_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eccc_ec    ON event_collaborator_clicks(event_collaborator_id);
CREATE INDEX IF NOT EXISTS idx_eccc_kind  ON event_collaborator_clicks(click_kind);
CREATE INDEX IF NOT EXISTS idx_eccc_contact ON event_collaborator_clicks(contact_id);

COMMIT;
