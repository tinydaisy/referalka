-- Миграция 105: ассистент клиента (один на клиента)
--
-- Один клиент = один ассистент с урезанными правами доступа в кабинет.
-- Имеет свой email + пароль для входа на /login (тот же экран что у клиента).
-- JWT при логине помечается role='assistant', client_id указывает на клиента-владельца.
--
-- password_plain хранится в открытом виде специально — клиент в /dashboard/settings
-- видит пароль ассистента под иконкой-глазиком (чтобы переслать ассистенту повторно,
-- например в мессенджер). Это сознательный trade-off безопасности ради UX.

CREATE TABLE client_assistants (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    password_plain  TEXT NOT NULL,
    last_login_at   TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ix_client_assistants_email_lower ON client_assistants (LOWER(email));
