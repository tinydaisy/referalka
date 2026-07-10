-- 209: помощник кабинета — связь «многие ко многим»
--
-- Было: client_assistants — одна строка = один помощник у одного клиента.
--   · UNIQUE(client_id) — у клиента не больше одного помощника
--   · UNIQUE(email)     — одна почта не могла вести два кабинета
--   · password_plain    — владелец видел пароль помощника открытым текстом
--
-- Стало: человек и его пропуска — разные сущности.
--   · assistants        — ЧЕЛОВЕК: почта + один пароль на все кабинеты
--   · assistant_grants  — ПРОПУСК: «этот человек допущен в этот кабинет с такими правами»
--
-- Клиент подключает сколько угодно помощников; помощник ведёт сколько угодно
-- кабинетов, в каждом со своим уровнем доступа. Пароль владельцу не показывается:
-- новому помощнику он уходит письмом, существующему — только уведомление о доступе.
--
-- Таблица clients НЕ трогается. Почта, зарегистрированная клиентом ПЛЮСОНа,
-- помощником быть не может (проверка в коде) — иначе вход не решил бы,
-- чей пароль спрашивать.

CREATE TABLE IF NOT EXISTS assistants (
    id             SERIAL PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    name           TEXT,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_assistants_email_lower ON assistants (LOWER(email));

CREATE TABLE IF NOT EXISTS assistant_grants (
    id            SERIAL PRIMARY KEY,
    assistant_id  INTEGER NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    client_id     INTEGER NOT NULL REFERENCES clients(id)    ON DELETE CASCADE,
    access_level  TEXT NOT NULL DEFAULT 'limited'
                  CHECK (access_level IN ('full', 'limited')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (assistant_id, client_id)
);

CREATE INDEX IF NOT EXISTS ix_assistant_grants_client_id ON assistant_grants (client_id);

-- Перенос данных из старой таблицы (на момент миграции она пуста, но перенос
-- оставлен на случай отката/повтора на другом окружении).
INSERT INTO assistants (email, password_hash, last_login_at, created_at, updated_at)
SELECT ca.email, ca.password_hash, ca.last_login_at, ca.created_at, ca.updated_at
  FROM client_assistants ca
 WHERE NOT EXISTS (SELECT 1 FROM assistants a WHERE LOWER(a.email) = LOWER(ca.email));

INSERT INTO assistant_grants (assistant_id, client_id, access_level, created_at, updated_at)
SELECT a.id, ca.client_id, ca.access_level, ca.created_at, ca.updated_at
  FROM client_assistants ca
  JOIN assistants a ON LOWER(a.email) = LOWER(ca.email)
 ON CONFLICT (assistant_id, client_id) DO NOTHING;

DROP TABLE IF EXISTS client_assistants;

GRANT SELECT, INSERT, UPDATE, DELETE ON assistants, assistant_grants TO plusson;
GRANT USAGE, SELECT ON SEQUENCE assistants_id_seq, assistant_grants_id_seq TO plusson;
