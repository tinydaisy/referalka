-- 125_referral_program.sql
-- Реф-программа ПЛЮСОНа: клиенты приглашают других клиентов и получают
-- 10% от их оплат (карточная часть, не trial и не бонусы) на бонусный баланс.
--
-- Это этап 3 проекта оплаты подписки. Этапы 1+2 — миграции 116, 119, 120.
--
-- Реф-ссылки:
--   pluson.ru/?pid={referral_code}              ← главная страница ПЛЮСОНа
--   t.me/pluson_bot?start=ref{referral_code}    ← через бот @pluson_bot
--
-- Алфавит реф-кода — без визуально похожих символов (0/o, 1/l/i).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS referral_code         TEXT,
  ADD COLUMN IF NOT EXISTS referred_by_client_id INTEGER NULL REFERENCES clients(id) ON DELETE SET NULL;

-- Генерим коды для существующих клиентов
DO $$
DECLARE
  c RECORD;
  alphabet TEXT := '23456789abcdefghjkmnpqrstuvwxyz';
  code TEXT;
  i INT;
BEGIN
  FOR c IN SELECT id FROM clients WHERE referral_code IS NULL LOOP
    LOOP
      code := '';
      FOR i IN 1..8 LOOP
        code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      END LOOP;
      -- проверка коллизий
      IF NOT EXISTS (SELECT 1 FROM clients WHERE referral_code = code) THEN
        UPDATE clients SET referral_code = code WHERE id = c.id;
        EXIT;
      END IF;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE clients
  ALTER COLUMN referral_code SET NOT NULL,
  ADD CONSTRAINT clients_referral_code_key UNIQUE (referral_code);

CREATE INDEX IF NOT EXISTS clients_referred_by_idx ON clients (referred_by_client_id)
  WHERE referred_by_client_id IS NOT NULL;
