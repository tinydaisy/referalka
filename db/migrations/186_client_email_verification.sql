-- Миграция 186: подтверждение email клиента
--
-- Клиент при регистрации получает письмо со ссылкой подтверждения email.
-- Пока email не подтверждён — в кабинете сверху висит плашка-напоминание,
-- и заблокированы РАССЫЛКИ (воронки лид-магнитов при этом работают).
--
-- Существующим клиентам ставим email_verified = FALSE — плашка покажется всем,
-- пока не подтвердят (решение пользователя от 2026-07-02).

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ NULL;

-- Токены подтверждения email (по аналогии с password_reset_tokens).
-- Храним sha256-хеш токена, живёт 7 дней.
CREATE TABLE IF NOT EXISTS email_verify_tokens (
    id          BIGSERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verify_token_hash ON email_verify_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verify_unused ON email_verify_tokens (client_id, used_at) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_verify_tokens TO plusson;
GRANT USAGE, SELECT ON email_verify_tokens_id_seq TO plusson;
