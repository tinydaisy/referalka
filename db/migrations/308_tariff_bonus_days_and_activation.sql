-- 308: Бонус ПЛЮСОНа — срок В ДНЯХ и выдача ПО ССЫЛКЕ, а не сразу
--
-- Что меняется по сравнению с миграцией 307:
--
-- 1. СРОК В ДНЯХ. Было `bonus_months` (месяцы). Клиент думает в днях
--    («доступ на 30 дней»), и письмо должно говорить так же. Месяцы
--    переводим ×30, поэтому у настроенных тарифов «1 месяц» становится
--    «30 дней» — для клиента ничего не меняется.
--
-- 2. ДОСТУП НЕ ВЫДАЁТСЯ В МОМЕНТ ОПЛАТЫ. Раньше кабинет создавался и модуль
--    включался сразу по вебхуку, а письмо уходило следом. Человек мог
--    открыть письмо через две недели — и обнаружить, что половина срока
--    сгорела, пока письмо лежало непрочитанным.
--    Теперь оплата только СОЗДАЁТ ЗАПИСЬ «этому человеку положен доступ»,
--    а кабинет, подписка и модуль включаются при первом переходе по ссылке
--    из письма. Отсчёт срока идёт с этого момента.
--
-- ⚠️ Никаких промокодов человек не вводит — просто ссылка из письма.
--
-- ⚠️ Ссылка ОДНОРАЗОВАЯ (`activated_at`) — иначе по ней продлевали бы доступ
--    бесконечно. Живёт 90 дней (`expires_at`): вечная ссылка всплыла бы через
--    год, когда и цены, и состав модулей уже другие.

-- ── 1. Срок в днях ───────────────────────────────────────────────────────
ALTER TABLE event_tariffs
    ADD COLUMN IF NOT EXISTS bonus_days INTEGER;

UPDATE event_tariffs
   SET bonus_days = GREATEST(1, COALESCE(bonus_months, 1)) * 30
 WHERE bonus_days IS NULL AND bonus_feature_id IS NOT NULL;

COMMENT ON COLUMN event_tariffs.bonus_days IS
  'Срок бонусного доступа В ДНЯХ. NULL = 30. Колонка bonus_months оставлена как легаси (мигр. 307), новый код читает bonus_days.';

-- ── 2. Купон: что человеку положено и активировал ли он ──────────────────
-- Одна строка на оплаченный заказ. Пока не активирован — доступа у человека
-- нет вообще (кабинет может даже не существовать).
CREATE TABLE IF NOT EXISTS plusson_bonus_coupons (
    id              SERIAL PRIMARY KEY,
    -- Откуда пришёл бонус. order_id — заказ тарифа события (уникален:
    -- платёжки шлют оповещение по нескольку раз).
    order_id        INTEGER UNIQUE REFERENCES event_participant_tariffs(id) ON DELETE CASCADE,
    event_tariff_id INTEGER REFERENCES event_tariffs(id) ON DELETE SET NULL,
    -- Кто выдал (владелец события) — он же реферал нового клиента.
    issuer_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    -- Кому. Почта — единственный надёжный ключ: кабинет ПЛЮСОНа заводится
    -- на неё же.
    email           TEXT NOT NULL,
    contact_id      INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    name            TEXT,
    phone           TEXT,
    -- Что именно положено.
    feature_id      INTEGER REFERENCES features(id) ON DELETE SET NULL,
    days            INTEGER NOT NULL DEFAULT 30,
    -- Ссылка активации (храним ХЕШ, как у восстановления пароля: утечка
    -- таблицы не должна давать доступ к чужим бонусам).
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    activated_at    TIMESTAMPTZ,
    -- Что получилось при активации — для разбора обращений.
    client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    client_created  BOOLEAN NOT NULL DEFAULT FALSE,
    outcome         TEXT,
    -- Напоминания: сколько уже отправили (0..3), чтобы не слать по кругу.
    reminders_sent  INTEGER NOT NULL DEFAULT 0,
    last_reminder_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bonus_coupons_pending
    ON plusson_bonus_coupons (expires_at)
 WHERE activated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bonus_coupons_email
    ON plusson_bonus_coupons (LOWER(email));

COMMENT ON TABLE plusson_bonus_coupons IS
  'Бонусный доступ в ПЛЮСОН, выданный за оплату тарифа события. Доступ включается ТОЛЬКО при переходе по ссылке из письма (activated_at), срок считается с этого момента.';

GRANT SELECT, INSERT, UPDATE, DELETE ON plusson_bonus_coupons TO plusson;
GRANT USAGE, SELECT ON SEQUENCE plusson_bonus_coupons_id_seq TO plusson;
