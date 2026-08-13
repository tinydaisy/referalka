-- 292: Коды входа в кабинет купившего (2026-08-13)
--
-- Человек, купивший продукт, заходит в свой кабинет `/my` двумя путями:
--   • по ссылке из бота или письма — там он уже опознан;
--   • сам, с чужого устройства — вводит почту и получает одноразовый код.
--
-- Пароля у покупателя нет и заводить его не нужно: он не сотрудник, а клиент,
-- заходит редко, и лишний пароль он просто забудет. Код на почту — тот же
-- способ, что уже используется в кабинете спикера.
--
-- ⚠️ Храним ХЕШ кода, а не сам код: утечка таблицы не должна давать вход.
-- ⚠️ Код живёт 15 минут и гасится после первого использования (`used_at`).

BEGIN;

CREATE TABLE IF NOT EXISTS product_cabinet_codes (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

    code_hash   TEXT        NOT NULL,       -- sha256 от шестизначного кода
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Поиск идёт по (клиент, хеш) среди живых кодов.
CREATE INDEX IF NOT EXISTS idx_product_cabinet_codes_lookup
    ON product_cabinet_codes(client_id, code_hash)
    WHERE used_at IS NULL;

-- Для периодической чистки просроченных.
CREATE INDEX IF NOT EXISTS idx_product_cabinet_codes_expires
    ON product_cabinet_codes(expires_at);

COMMENT ON TABLE product_cabinet_codes IS
    'Одноразовые коды входа в кабинет купившего. Хранится хеш, срок 15 минут';

-- ⚠️ Роль plusson не владелец таблиц.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_cabinet_codes TO plusson;
GRANT USAGE, SELECT ON product_cabinet_codes_id_seq TO plusson;

COMMIT;
