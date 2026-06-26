-- 169_client_default_link_mode.sql
-- Общая клиентская настройка: куда ведут публичные ссылки и кнопки /start —
-- в Mini App (внутри Telegram/VK) или через бота (ЛС-флоу).
--
-- Семантика резолва везде в коде:
--   lm = events.link_mode (если задан явно) OR clients.default_link_mode OR 'miniapp'
-- Поле events.link_mode НЕ удаляется — остаётся как пер-событийное переопределение
-- (radio в UI событий пока скрыт, но БД-логика переопределения заложена на будущее).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS default_link_mode TEXT NOT NULL DEFAULT 'miniapp';

-- Настраиваемое приветствие /start у бота клиента (VIP-бот).
-- 2 кнопки: «Все события» и «Об основателе» — названия настраиваемые.
-- Пустые значения → дефолтные тексты в коде.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS start_greeting_text   TEXT NULL,
  ADD COLUMN IF NOT EXISTS start_btn_events_label TEXT NULL,
  ADD COLUMN IF NOT EXISTS start_btn_owner_label  TEXT NULL;

-- Допустимые значения: 'miniapp' | 'bot'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'clients' AND constraint_name = 'clients_default_link_mode_chk'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_default_link_mode_chk
      CHECK (default_link_mode IN ('miniapp', 'bot'));
  END IF;
END$$;
