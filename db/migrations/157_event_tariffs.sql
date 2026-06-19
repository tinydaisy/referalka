-- Миграция 157: Тарифы мероприятия + признак оплаты у участника + оферта события.
--
-- Зачем. До этого «VIP» события = одна ссылка events.vip_url, без признака
-- покупки на участнике. Из платёжки (GetCourse/Продамус/ЮKassa) приходит вебхук
-- «оплатил» → надо знать, КАКОЙ тариф купили (у события может быть несколько).
-- Поэтому: настраиваемые тарифы события (event_tariffs) + связь «кто что оплатил»
-- (event_participant_tariffs). Раздел показывается только клиентам тарифа vip.

-- 1) Тарифы мероприятия. code — стабильный идентификатор для вебхука оплаты.
CREATE TABLE IF NOT EXISTS event_tariffs (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,                 -- 'vip', 'standard' — для вебхука оплаты
    title       TEXT NOT NULL,                 -- «VIP-доступ»
    description TEXT,
    price       INTEGER,                       -- сумма в рублях; NULL = «по запросу»
    pay_url     TEXT,                          -- ссылка на оплату (Продамус/ЮKassa/любая)
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, code)
);
COMMENT ON TABLE event_tariffs IS 'Платные тарифы мероприятия (VIP и др.). code — идентификатор для вебхука оплаты.';

-- 2) Кто какой тариф оплатил. M2M (на будущее — участник может купить несколько).
CREATE TABLE IF NOT EXISTS event_participant_tariffs (
    id                  SERIAL PRIMARY KEY,
    event_id            INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    participant_id      INTEGER NOT NULL REFERENCES event_participants(id) ON DELETE CASCADE,
    tariff_id           INTEGER NOT NULL REFERENCES event_tariffs(id) ON DELETE CASCADE,
    paid_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source              TEXT,                  -- getcourse | prodamus | manual | ...
    amount              INTEGER,               -- фактически уплачено (для сверки)
    external_payment_id TEXT,                  -- id платежа во внешней системе
    UNIQUE (participant_id, tariff_id)         -- повторный вебхук не плодит дубль
);
COMMENT ON TABLE event_participant_tariffs IS 'Факт оплаты тарифа участником события.';
CREATE INDEX IF NOT EXISTS idx_ept_event_tariff ON event_participant_tariffs (event_id, tariff_id);

-- 3) Оферта события — одна на всё мероприятие, хранится ссылкой.
ALTER TABLE events ADD COLUMN IF NOT EXISTS offer_url TEXT;
COMMENT ON COLUMN events.offer_url IS 'Ссылка на оферту мероприятия (PDF/страница), общая для всех тарифов.';

-- GRANT-ы для роли plusson (см. правило в CLAUDE.md).
GRANT SELECT, INSERT, UPDATE, DELETE ON event_tariffs, event_participant_tariffs TO plusson;
GRANT USAGE, SELECT ON event_tariffs_id_seq, event_participant_tariffs_id_seq TO plusson;
