-- 391. Тех-специалисты (внедренцы) — третий тип входа в систему.
--
-- До этого входов было два: КЛИЕНТ (свой кабинет) и АДМИН (вся платформа).
-- Тех-спец — ни то ни другое: он видит СРЕЗ данных платформы по закреплённым за
-- ним клиентам. В кабинет клиента его пускать нельзя (там чужие деньги и
-- контакты), в админку — тем более (там все клиенты и тарифы).
--
-- ⚠️⚠️ ПОЧЕМУ НЕ ЗАВЕЛИ ЕГО ОБЫЧНЫМ КЛИЕНТОМ. Такой вариант обсуждался: клиент
-- получает свой кабинет, изоляцию и партнёрку бесплатно. Но данные, по которым
-- считается его работа — тариф, продления, даты оплат — живут в
-- `client_subscriptions` и `subscription_orders`, а в кабинете клиента их нет ни
-- при каком уровне доступа: там показываются КОНТАКТЫ (люди в базе клиента), а
-- не КЛИЕНТЫ ПЛАТФОРМЫ. Считать фикс и активации оттуда нечем.
--
-- ⚠️ Образец — `assistants` + `assistant_grants` (миграция 209): человек отдельно,
-- доступ отдельно. Здесь та же пара, но вторая таблица связывает специалиста не
-- с кабинетом, а с КЛИЕНТОМ ПЛАТФОРМЫ, за которого он отвечает.

-- ── Сам человек ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tech_specialists (
    id            SERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT,
    phone         TEXT,
    -- Куда писать по рабочим вопросам.
    telegram_username TEXT,

    -- ⚠️ Право править материалы Коллабораторной даётся ПОИМЕННО: их видят все
    -- купившие модуль, и ошибка одного человека видна всей платформе.
    can_edit_materials BOOLEAN NOT NULL DEFAULT FALSE,

    -- Уволенный не удаляется: на нём висит история начислений, а удаление
    -- строки унесло бы и её. Неактивный просто не может войти.
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_tech_specialists_email_lower
    ON tech_specialists (LOWER(email));

-- ── За кем закреплён клиент ──────────────────────────────────────────────
-- ⚠️ Колонка на `clients`, а не отдельная таблица связей: у клиента ровно один
-- ответственный в каждый момент. Таблица допускала бы двоих сразу, и тогда фикс
-- считался бы дважды.
--
-- ⚠️ ON DELETE SET NULL: специалиста в норме не удаляют (см. выше), но если
-- строку всё же убрали — клиент должен остаться без ответственного, а не
-- исчезнуть вместе с ним.
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS tech_specialist_id INTEGER
        REFERENCES tech_specialists(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS tech_assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_clients_tech_specialist
    ON clients (tech_specialist_id) WHERE tech_specialist_id IS NOT NULL;

-- ── История передач ──────────────────────────────────────────────────────
-- ⚠️⚠️ ПЕРЕДАЧА КЛИЕНТА РАЗРЕШЕНА, и начисления идут НОВОМУ (решение владельца).
-- Значит нужна история: без неё нельзя ответить, почему за март фикс достался
-- одному, а за апрель другому, и разговор о деньгах вести нечем.
CREATE TABLE IF NOT EXISTS tech_client_transfers (
    id           SERIAL PRIMARY KEY,
    client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    -- NULL = клиент был ничей (первое закрепление) или стал ничьим (снятие).
    from_spec_id INTEGER REFERENCES tech_specialists(id) ON DELETE SET NULL,
    to_spec_id   INTEGER REFERENCES tech_specialists(id) ON DELETE SET NULL,
    reason       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_tech_transfers_client
    ON tech_client_transfers (client_id, created_at DESC);

-- ── Начисления ───────────────────────────────────────────────────────────
-- ⚠️⚠️ НАЧИСЛЕНИЕ ХРАНИТСЯ СТРОКОЙ, А НЕ СЧИТАЕТСЯ НА ЛЕТУ. Считать «сколько
-- активаций было в марте» запросом каждый раз нельзя: клиента могли передать
-- другому, тариф сменить, оплату вернуть — и цифра за прошлый месяц изменилась
-- бы задним числом уже после выплаты. Тот же принцип, что у `partner_accruals`.
CREATE TABLE IF NOT EXISTS tech_accruals (
    id         SERIAL PRIMARY KEY,
    spec_id    INTEGER NOT NULL REFERENCES tech_specialists(id) ON DELETE CASCADE,
    client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,

    -- За что: activation — довёл до второй оплаты; revival — оживил остывшего;
    -- fix — фикс за обслуживание (раз в месяц); referral — процент за лично
    -- приведённого; bonus — ручное начисление владельцем.
    kind       TEXT NOT NULL
               CHECK (kind IN ('activation', 'revival', 'fix', 'referral', 'bonus')),

    amount_kopecks INTEGER NOT NULL DEFAULT 0,

    -- Откуда взялось: оплата, за которую начислено (у fix пусто — он за месяц).
    source_order_id INTEGER REFERENCES subscription_orders(id) ON DELETE SET NULL,
    -- Месяц, к которому относится начисление: 'YYYY-MM'. У фикса это ключ
    -- уникальности, у остального — просто отчётный период.
    period     TEXT,

    note       TEXT,
    -- Отметка выплаты. NULL = ещё не выплачено.
    paid_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_tech_accruals_spec
    ON tech_accruals (spec_id, created_at DESC);

-- ⚠️ Защита от двойного начисления живёт В БАЗЕ, а не в коде: задача считает
-- начисления по расписанию и может быть перезапущена, а деньги дважды за одно
-- и то же — это спор с человеком, которому платят.
--   • за оплату: одна строка на (специалист, вид, оплата);
--   • за фикс:   одна строка на (специалист, клиент, месяц).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tech_accrual_order
    ON tech_accruals (spec_id, kind, source_order_id)
    WHERE source_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tech_accrual_fix
    ON tech_accruals (spec_id, client_id, period)
    WHERE kind = 'fix';

-- ── Правила начисления ───────────────────────────────────────────────────
-- ⚠️⚠️ СУММЫ В БАЗЕ, А НЕ В КОДЕ (решение владельца «считать автоматически»).
-- Ставки меняются: сегодня фикс 300 ₽, завтра 500. В коде это значило бы релиз
-- на каждую правку и невозможность объяснить старые начисления — они считались
-- по прежней ставке, а в коде уже новая.
CREATE TABLE IF NOT EXISTS tech_rates (
    id         SERIAL PRIMARY KEY,
    kind       TEXT NOT NULL UNIQUE
               CHECK (kind IN ('activation', 'revival', 'fix', 'referral')),
    -- Для activation/revival/fix — рубли в копейках. Для referral не
    -- используется (там процент).
    amount_kopecks INTEGER NOT NULL DEFAULT 0,
    -- Для referral — процент с оплаты приведённого им клиента.
    percent    NUMERIC(5,2) NOT NULL DEFAULT 0,
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Стартовые ставки. ⚠️ Правятся в админке, не миграцией: следующая правка
-- ставки не должна требовать выкатки.
INSERT INTO tech_rates (kind, amount_kopecks, percent) VALUES
    ('activation', 50000, 0),    -- 500 ₽ за доведённого до второй оплаты
    ('revival',    30000, 0),    -- 300 ₽ за оживлённого остывшего
    ('fix',        30000, 0),    -- 300 ₽ в месяц за обслуживание платящего
    ('referral',       0, 10)    -- 10 % с оплат лично приведённого
ON CONFLICT (kind) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON
    tech_specialists, tech_client_transfers, tech_accruals, tech_rates TO plusson;
GRANT USAGE, SELECT ON
    tech_specialists_id_seq, tech_client_transfers_id_seq,
    tech_accruals_id_seq, tech_rates_id_seq TO plusson;
