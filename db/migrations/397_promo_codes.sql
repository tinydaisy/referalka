-- 397. Промокоды ПЛЮСОНа — свои, независимые от платёжных систем.
--
-- ЗАЧЕМ СВОИ, а не промокоды платёжек (решение владельца 09.09.2026):
--   • LeadPay прямым текстом пишет: «Промокоды действуют на карточки товара,
--     созданные в LeadPay. Работаете через интеграцию? Реализуйте функционал
--     на своей стороне». Мы работаем именно через интеграцию.
--   • Продамус — промокоды в его кабинете, к нашим заказам не привязаны.
--   • Т-Банк — чистый эквайринг, промокодов нет вовсе (в методе Init нет ни
--     одного поля про скидки).
--   Итог: у каждой системы свои правила, две из трёх не покрывают наш поток,
--   и ни одна не умеет ИМЕННЫХ кодов. Делаем у себя — работает одинаково
--   везде, привязывается к нашим событиям и продуктам, и мы видим в заказе,
--   какой код сработал.
--
-- ⚠️ ИМЕННОЙ И ОДНОРАЗОВЫЙ — ЭТО ОДНА СУЩНОСТЬ, а не две.
--   Разница в одном поле `recipient_contact_id`:
--     заполнено → код примет только этот человек (переслал другому — не сработает);
--     пусто     → примет любой, кто знает код, пока не кончились применения.
--   Двумя таблицами это делать нельзя: правила срока, лимита и привязки у них
--   одинаковые, и копии неминуемо разъедутся.
--
-- ⚠️ ПРИМЕНЕНИЕ СЧИТАЕТСЯ ПО ОПЛАТЕ, А НЕ ПО ВВОДУ КОДА.
--   У LeadPay наоборот: активация списывается, когда человек ввёл код и перешёл
--   к оплате — даже если не заплатил. Так лимит в 100 применений выгорает, не
--   продав ничего. У нас код резервируется при создании заказа и списывается
--   при подтверждении оплаты.

-- ─────────────────────────────────────────────────────────────────────────────
-- Сам промокод
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
    id                   SERIAL PRIMARY KEY,

    -- Чей код. NULL = код самого ПЛЮСОНа (скидка на подписку платформы),
    -- их заводит админ в /admin. Иначе — код клиента на его события и продукты.
    client_id            INTEGER REFERENCES clients(id) ON DELETE CASCADE,

    -- Само слово. Регистр не значим: сверяем по code_norm, а показываем code
    -- так, как ввёл клиент (PLUSON20 читается лучше, чем pluson20).
    code                 TEXT NOT NULL,
    code_norm            TEXT NOT NULL,

    -- Скидка. Те же два вида, что у скидки тарифа (миграция 305) — чтобы
    -- считать одной функцией tariff_discount, а не заводить вторую формулу.
    discount_kind        TEXT NOT NULL CHECK (discount_kind IN ('percent', 'amount')),
    discount_value       INTEGER NOT NULL CHECK (discount_value > 0),

    -- На что действует. Пусто во всех трёх → «на всё».
    -- ⚠️ По умолчанию в интерфейсе выбрано «выбранное», а не «на всё»: код
    -- «на всё» молча действует на событие за 50 000 ₽, о котором не думали,
    -- и обнаруживается это по деньгам задним числом.
    scope_event_id       INTEGER REFERENCES events(id) ON DELETE CASCADE,
    scope_product_id     INTEGER REFERENCES products(id) ON DELETE CASCADE,
    scope_tariff_id      INTEGER,           -- event_tariffs.id или product_tariffs.id
    scope_tariff_kind    TEXT CHECK (scope_tariff_kind IN ('event', 'product')),

    -- Скидка на подписку самого ПЛЮСОНа: код действует на этот тариф платформы
    -- (NULL при заполненном plusson_subscription = на любой тариф).
    plusson_subscription BOOLEAN NOT NULL DEFAULT FALSE,
    scope_plan_slug      TEXT,

    -- ⚠️ ИМЕННОЙ: заполнено — код примет только этот человек.
    -- Контакт живёт в базе КЛИЕНТА, поэтому для кодов ПЛЮСОНа (client_id IS NULL)
    -- именных не бывает — там получатель это сам клиент платформы.
    recipient_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    recipient_client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,

    -- Сколько раз можно применить. NULL = без ограничения по количеству.
    max_uses             INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
    used_count           INTEGER NOT NULL DEFAULT 0,

    -- Срок. NULL = бессрочно.
    starts_at            TIMESTAMPTZ,
    ends_at              TIMESTAMPTZ,

    is_active            BOOLEAN NOT NULL DEFAULT TRUE,

    -- Пачка кодов, созданных генератором за один раз: в списке они
    -- показываются ОДНОЙ свёрнутой строкой, иначе 200 строк ZHIVU-A7K2
    -- погребут под собой три обычных промокода — это и есть «помойка».
    batch_id             TEXT,
    batch_title          TEXT,

    comment              TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- ⚠️ Ветки обёрнуты в COALESCE НАМЕРЕННО: без него пара (NULL, что-то)
    -- даёт NULL, а не FALSE, и CHECK такую строку ПРОПУСКАЕТ — в SQL
    -- неизвестность считается выполненной. На этом уже обжигались в миграции 305.
    CONSTRAINT promo_codes_tariff_kind_ck CHECK (
        COALESCE((scope_tariff_id IS NULL) = (scope_tariff_kind IS NULL), FALSE)
    )
);

-- Код уникален в пределах владельца. Частичные индексы, потому что у кодов
-- ПЛЮСОНа client_id = NULL, а NULL в обычном UNIQUE не сравнивается сам с собой
-- и дубли прошли бы насквозь.
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_client_code_uniq
    ON promo_codes (client_id, code_norm) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_platform_code_uniq
    ON promo_codes (code_norm) WHERE client_id IS NULL;

CREATE INDEX IF NOT EXISTS promo_codes_client_idx    ON promo_codes (client_id);
CREATE INDEX IF NOT EXISTS promo_codes_event_idx     ON promo_codes (scope_event_id)   WHERE scope_event_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS promo_codes_product_idx   ON promo_codes (scope_product_id) WHERE scope_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS promo_codes_batch_idx     ON promo_codes (batch_id)         WHERE batch_id         IS NOT NULL;
CREATE INDEX IF NOT EXISTS promo_codes_recipient_idx ON promo_codes (recipient_contact_id) WHERE recipient_contact_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Применения — кто, когда и каким заказом воспользовался
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Отдельная таблица, а не колонки в промокоде: у кода с лимитом 200 будет
-- 200 применений, и «кто применил» — главный вопрос по именным кодам.
CREATE TABLE IF NOT EXISTS promo_code_uses (
    id               SERIAL PRIMARY KEY,
    promo_code_id    INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,

    contact_id       INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    client_id        INTEGER REFERENCES clients(id) ON DELETE SET NULL,  -- для кодов ПЛЮСОНа

    -- Каким заказом. Один из трёх — смотря что оплачивали.
    event_order_id   INTEGER REFERENCES event_participant_tariffs(id) ON DELETE SET NULL,
    product_order_id INTEGER REFERENCES product_orders(id) ON DELETE SET NULL,
    subscription_order_id INTEGER REFERENCES subscription_orders(id) ON DELETE SET NULL,

    -- Сколько это стоило: цена до и после. Обе нужны, чтобы объяснить клиенту
    -- расхождение «в тарифе 5000, на счёт пришло 4000».
    price_before     INTEGER NOT NULL,
    price_after      INTEGER NOT NULL,

    -- 'reserved' — заказ создан, оплаты ещё нет;
    -- 'applied'  — оплата подтверждена (или цена стала 0 и доступ выдан сразу);
    -- 'released' — заказ отменён/протух, применение вернулось в лимит.
    status           TEXT NOT NULL DEFAULT 'reserved'
                     CHECK (status IN ('reserved', 'applied', 'released')),

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS promo_code_uses_code_idx    ON promo_code_uses (promo_code_id);
CREATE INDEX IF NOT EXISTS promo_code_uses_contact_idx ON promo_code_uses (contact_id) WHERE contact_id IS NOT NULL;

-- Один заказ — одно применение. Иначе повторный вебхук (норма для платёжек)
-- списал бы код второй раз.
CREATE UNIQUE INDEX IF NOT EXISTS promo_code_uses_event_order_uniq
    ON promo_code_uses (event_order_id)   WHERE event_order_id   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS promo_code_uses_product_order_uniq
    ON promo_code_uses (product_order_id) WHERE product_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS promo_code_uses_subscription_order_uniq
    ON promo_code_uses (subscription_order_id) WHERE subscription_order_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Промокод в заказе — чтобы в списке заказов было видно, откуда скидка
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE event_participant_tariffs
    ADD COLUMN IF NOT EXISTS promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS promo_code    TEXT;

ALTER TABLE product_orders
    ADD COLUMN IF NOT EXISTS promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS promo_code    TEXT;

ALTER TABLE subscription_orders
    ADD COLUMN IF NOT EXISTS promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS promo_code    TEXT;

-- ⚠️ Само слово дублируем строкой рядом с id НАМЕРЕННО: промокод могут
-- удалить, а заказ обязан помнить, по какому коду прошла скидка — иначе
-- в отчёте останется скидка без объяснения.

-- ⚠️ Роль plusson НЕ владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON promo_codes, promo_code_uses TO plusson;
GRANT USAGE, SELECT ON SEQUENCE promo_codes_id_seq, promo_code_uses_id_seq TO plusson;
