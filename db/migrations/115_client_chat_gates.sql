-- 115_client_chat_gates.sql
-- 2026-05-26
--
-- Гейт по подписке в Telegram-чатах клиента.
--
-- Клиент включает в своих TG-чатах правило: участник может писать только
-- если подписан на ВСЕ TG-каналы основателя (хранятся в массиве
-- clients.social_links->'telegram_channels', см. миграцию 114).
--
-- Бот, получив сообщение в группе:
--   1) ищет client_chat_gates по chat.id и is_active=TRUE;
--   2) подтягивает каналы основателя клиента;
--   3) параллельно делает getChatMember для каждого канала;
--   4) если хоть в одном канале бот сам не админ — автоматически выключает
--      гейт (is_active=FALSE, last_error, last_error_at) и сообщение НЕ
--      удаляет; UI клиента покажет красный баннер;
--   5) если юзер подписан на все каналы — пропускает сообщение;
--   6) иначе удаляет сообщение и шлёт предупреждение со списком неподписанных
--      каналов (как reply на удалённое сообщение, авто-удаление через TTL).
--
-- Какой бот делает проверку: VIP-бот клиента если есть подключённый TG-канал,
-- иначе системный @pluson_bot. Резолв через клиента (channels + client_channels).
--
-- Один и тот же чат у разных клиентов запрещён (UNIQUE).

BEGIN;

CREATE TABLE IF NOT EXISTS client_chat_gates (
  id              BIGSERIAL PRIMARY KEY,
  client_id       BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  chat_id         TEXT   NOT NULL,                       -- Telegram chat ID (-100..., или @username)
  chat_title      TEXT,                                  -- для отображения в дашборде
  warning_text    TEXT,                                  -- кастомный текст; NULL → дефолт
  warning_ttl_sec INT    NOT NULL DEFAULT 15 CHECK (warning_ttl_sec BETWEEN 5 AND 600),
  is_active       BOOLEAN NOT NULL DEFAULT FALSE,        -- по умолчанию выкл, пользователь сам включает
  last_error      TEXT,                                  -- причина авто-отключения (бот вылетел из канала и т.п.)
  last_error_at   TIMESTAMPTZ,
  last_check_at   TIMESTAMPTZ,                           -- когда последний раз проверили вручную
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id)                                       -- один чат — один владелец-клиент
);

CREATE INDEX IF NOT EXISTS idx_client_chat_gates_chat_active
  ON client_chat_gates(chat_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_client_chat_gates_client
  ON client_chat_gates(client_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON client_chat_gates TO plusson;
GRANT USAGE, SELECT ON client_chat_gates_id_seq TO plusson;

COMMIT;
