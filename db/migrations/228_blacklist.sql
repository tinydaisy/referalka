-- 228: Чёрный список
--
-- Две независимые сущности:
--  1. contact_blacklist — контакт в базе КОНКРЕТНОГО клиента не получает контент
--     из ботов этого клиента (рассылки, воронки, /start). Ставится кнопкой
--     на карточке контакта в /dashboard/clients.
--  2. clients.collab_hub_blocked — клиенту платформы закрыта покупка
--     Коллабораторной. Ставится галочкой админом в /admin/clients.
--
-- Это РАЗНЫЕ объекты: первое — про контакт в базе клиента, второе — про самого
-- клиента платформы. Одна операция не подразумевает другую.

CREATE TABLE IF NOT EXISTS contact_blacklist (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    reason      TEXT,
    added_by    TEXT,                     -- 'client' | 'admin' | 'system'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT contact_blacklist_unique UNIQUE (client_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_blacklist_client  ON contact_blacklist(client_id);
CREATE INDEX IF NOT EXISTS idx_contact_blacklist_contact ON contact_blacklist(contact_id);

-- Запрет покупки Коллабораторной (глобально, ставит админ)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS collab_hub_blocked BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_blacklist TO plusson;
GRANT USAGE, SELECT ON SEQUENCE contact_blacklist_id_seq TO plusson;
