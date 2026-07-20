-- 227: Управляемая ставка реф-программы ПЛЮСОНа + заморозка ставки на клиенте.
--
-- Было: 10% захардкожено в bonuses.py/subscriptions.py и читалось в момент
-- начисления. Смена процента задним числом била по всем, включая тех, кто
-- пришёл под обещанные 10%.
--
-- Стало: настройки в БД (админ правит), а ставка и срок начислений
-- ЗАМОРАЖИВАЮТСЯ на приведённом клиенте в момент его регистрации.
-- Меняешь процент в августе — новые получают новый, старые доживают на своём.

-- Настройки программы. Одна строка (id=1).
CREATE TABLE IF NOT EXISTS referral_program_settings (
    id                  INT PRIMARY KEY DEFAULT 1,
    percent             INT  NOT NULL DEFAULT 10 CHECK (percent >= 0 AND percent <= 100),
    -- До какой даты действует ТЕКУЩАЯ ставка: кто приведён по эту дату
    -- включительно, получает percent (замораживается на клиенте).
    signup_until        DATE NOT NULL DEFAULT '2026-07-31',
    -- До какой даты идут НАЧИСЛЕНИЯ приведённым по текущей ставке.
    accrual_until       DATE NOT NULL DEFAULT '2027-07-31',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT referral_program_settings_single CHECK (id = 1)
);

INSERT INTO referral_program_settings (id, percent, signup_until, accrual_until)
VALUES (1, 10, '2026-07-31', '2027-07-31')
ON CONFLICT (id) DO NOTHING;

-- Заморозка на приведённом клиенте: по какой ставке и до какой даты
-- начисляем его рефереру. NULL у тех, кто без реферера.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS referral_rate_percent   INT  NULL,
  ADD COLUMN IF NOT EXISTS referral_accrual_until  DATE NULL;

-- Бэкфилл: все существующие приведённые пришли под 10% до 31.07.2027.
UPDATE clients
   SET referral_rate_percent  = COALESCE(referral_rate_percent, 10),
       referral_accrual_until = COALESCE(referral_accrual_until, '2027-07-31')
 WHERE referred_by_client_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON referral_program_settings TO plusson;
