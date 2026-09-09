-- 393. Свой реф-код у внедренца + уровни приведённых.
--
-- ⚠️⚠️ ЧТО БЫЛО СЛОМАНО. Признак «мой приведённый» в кабинете считался так:
-- «тех-спец того, кто привёл этого клиента = я». Это совсем другое: означает
-- «клиента привёл кто-то, кого я обслуживаю», а не «привёл я сам». Процент
-- начислялся бы не тому.
--
-- Причина глубже: у внедренца НЕ БЫЛО своего реф-кода вовсе. Клиентов в ПЛЮСОНе
-- приводят КЛИЕНТЫ (`clients.referred_by_client_id`), а внедренец клиентом не
-- является — сказать «этого привёл он» системе было нечем.
--
-- ⚠️ Отдельная колонка `referred_by_tech_id`, а не запись в
-- `referred_by_client_id`: там лежит клиент-рефовод, которому идёт КЭШБЭК
-- деньгами. Подставить туда внедренца значило бы начислить ему ещё и клиентский
-- кэшбэк — двойная выплата за одно и то же.

ALTER TABLE tech_specialists
    ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- Код тем, у кого его нет. Алфавит без похожих символов — код диктуют голосом.
UPDATE tech_specialists
   SET referral_code = 'T' || UPPER(SUBSTRING(md5(random()::text || id::text) FOR 7))
 WHERE referral_code IS NULL;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS referred_by_tech_id INTEGER
        REFERENCES tech_specialists(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_clients_referred_by_tech
    ON clients (referred_by_tech_id) WHERE referred_by_tech_id IS NOT NULL;

COMMENT ON COLUMN tech_specialists.referral_code IS
    'Личный код внедренца для ссылки регистрации. Пришедший по ней клиент '
    'получает referred_by_tech_id — за него идёт процент.';
COMMENT ON COLUMN clients.referred_by_tech_id IS
    'Внедренец, ЛИЧНО приведший клиента. Не путать с referred_by_client_id — '
    'там клиент-рефовод, которому идёт денежный кэшбэк.';
