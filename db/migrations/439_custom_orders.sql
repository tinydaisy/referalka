-- 439. Персональные заказы: произвольная услуга, произвольная цена.
--
-- ⚠️⚠️ ЗАЧЕМ ОТДЕЛЬНАЯ СУЩНОСТЬ, а не тариф продукта. У продукта цена задана
-- карточкой: сколько написано, столько и платят. Здесь наоборот — объём работы
-- заранее НЕИЗВЕСТЕН. Человек пишет «нужна личная настройка», мы созваниваемся
-- и только потом понимаем, домен это подключить за час или вебинар вести месяц.
-- Поэтому цена и перечень работ живут В САМОМ ЗАКАЗЕ, а прайс ниже — только
-- подсказка, чтобы не вспоминать суммы по памяти.

-- ── Прайс услуг: что сколько стоит ────────────────────────────────────────
-- ⚠️ Это СПРАВОЧНИК, а не витрина. Цена отсюда подставляется в заказ и там
-- может быть изменена: «как договоримся» — штатный случай, а не исключение.
-- ⚠️ `title` УНИКАЛЕН намеренно — не ради красоты схемы, а чтобы начальный
-- INSERT ниже был идемпотентным. Миграции накатываются при КАЖДОМ деплое;
-- без уникального ключа `ON CONFLICT DO NOTHING` не срабатывает вовсе, и прайс
-- удваивался бы на каждой выкатке. Две услуги с одинаковым названием всё равно
-- неразличимы для человека.
CREATE TABLE IF NOT EXISTS service_price_items (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL UNIQUE,
    description TEXT,
    price       INTEGER NOT NULL DEFAULT 0,   -- рубли, как в event_tariffs
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE service_price_items IS
    'Прайс услуг. Ориентир для сборки персонального заказа, не витрина с оплатой.';

INSERT INTO service_price_items (title, description, price, sort_order) VALUES
    ('Подключение своего домена', 'Домен, DNS, сертификат, проверка почты на домене', 5000, 10),
    ('Подключение платёжной системы', 'ЛидПей / Продамус / Т-Банк: ключи, товары, проверка оплаты', 5000, 20),
    ('Настройка бота под ключ', 'Бот, Mini App, канал, группа поддержки', 7900, 30),
    ('Сопровождение вебинара', 'Тех.сопровождение эфира: комната, запись, помощь ведущему', 8000, 40),
    ('Перенос базы контактов', 'Разбор выгрузки, сопоставление полей, импорт', 5000, 50),
    ('Настройка воронки и рассылок', 'Сценарий, тексты по вашим материалам, расписание', 9000, 60)
ON CONFLICT (title) DO NOTHING;

-- ── Персональные заказы ──────────────────────────────────────────────────
-- ⚠️ Реквизиты НАШИ, ПЛЮСОНА: услугу оказывает компания, а техспецу потом
-- начисляется его доля по ставкам. Поэтому платёжка берётся из переменных
-- окружения (services/leadpay.py), а не из карточки клиента.
--
-- ⚠️ НЕТ tariff_id и НЕТ UNIQUE-констрейнта на «человека и товар»: у продуктов
-- повторный вебхук ловится связкой (contact_id, tariff_id), а здесь один и тот
-- же человек может заказать три разные настройки. Повтор гасится проверкой
-- статуса при оплате — как в event_orders._mark_order_paid.
CREATE TABLE IF NOT EXISTS custom_orders (
    id                  SERIAL PRIMARY KEY,
    number              TEXT UNIQUE,         -- человеческий номер: показываем на странице
    title               TEXT NOT NULL DEFAULT 'Персональный заказ',
    items               TEXT NOT NULL DEFAULT '',   -- перечень работ, просто текст построчно
    amount              INTEGER NOT NULL DEFAULT 0, -- рубли
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'sent', 'paid', 'cancelled')),
    -- Кому
    contact_id          INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    client_name         TEXT,
    client_email        TEXT,
    client_phone        TEXT,
    -- Кто оформил: NULL — владелец из админки, иначе техспец
    tech_specialist_id  INTEGER REFERENCES tech_specialists(id) ON DELETE SET NULL,
    -- ⚠️⚠️ ЧЕЙ ЛИД — от этого зависит СТАВКА техспеца, а не только отчётность.
    -- По таблице: клиент из базы ПЛЮСОНА даёт 60 % (`setup_pluson`), свой
    -- приведённый — 80 % (`setup_own`). Поле отдельное, а не вывод из
    -- `clients.referred_by_tech_id`, потому что персональный заказ часто
    -- оформляется ДО того, как человек стал клиентом платформы: связывать не с
    -- чем, а ставку назвать нужно уже сейчас.
    lead_source         TEXT NOT NULL DEFAULT 'pluson'
                        CHECK (lead_source IN ('pluson', 'own')),
    -- Оплата
    payment_url         TEXT,
    payment_provider    TEXT,
    external_payment_id TEXT,
    paid_at             TIMESTAMPTZ,
    -- Работа сделана. ⚠️ Отдельно от оплаты: деньги пришли — ещё не значит,
    -- что настройка выполнена, и наоборот (бывает оплата постфактум).
    is_done             BOOLEAN NOT NULL DEFAULT FALSE,
    done_at             TIMESTAMPTZ,
    note                TEXT,                -- заметка для себя, клиенту не видна
    request_text        TEXT,                -- что человек написал в заявке
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_orders_status ON custom_orders(status);
CREATE INDEX IF NOT EXISTS idx_custom_orders_tech ON custom_orders(tech_specialist_id);
CREATE INDEX IF NOT EXISTS idx_custom_orders_contact ON custom_orders(contact_id);

COMMENT ON COLUMN custom_orders.items IS
    'Перечень работ простым текстом, по строке на пункт. Показывается человеку как есть.';
COMMENT ON COLUMN custom_orders.number IS
    'Номер для человека (PZ-000123). В платёжку уходит ord-<id>, это разные вещи.';

-- ── Начисление техспецу за персональный заказ ────────────────────────────
-- ⚠️⚠️ ЗАЧЕМ ОТДЕЛЬНАЯ КОЛОНКА, а не `source_order_id`. Тот ссылается на
-- `subscription_orders` — оплаты подписок. Персональный заказ живёт в другой
-- таблице, и запись его id в чужую ссылку дала бы битую связь: id совпал бы со
-- случайной оплатой подписки.
--
-- ⚠️ Уникальный индекс обязателен. Вебхук платёжной системы приходит ПОВТОРНО
-- (это норма, а не сбой) — без защиты в БАЗЕ техспец получил бы за одну работу
-- дважды, а это спор с человеком, которому платят. Защищаться только кодом
-- нельзя: он же и перезапускается.
ALTER TABLE tech_accruals
    ADD COLUMN IF NOT EXISTS custom_order_id INTEGER
        REFERENCES custom_orders(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_tech_accrual_custom_order
    ON tech_accruals (spec_id, kind, custom_order_id)
    WHERE custom_order_id IS NOT NULL;

COMMENT ON COLUMN tech_accruals.custom_order_id IS
    'Персональный заказ, за который начислено. Ставка: 60 % лид ПЛЮСОНА, 80 % свой.';

-- ── Общий механизм: текст с сайта уезжает в бот ──────────────────────────
-- ⚠️⚠️ ПОЧЕМУ ТАБЛИЦА, А НЕ ПАРАМЕТР ССЫЛКИ. В `?start=` у Telegram помещается
-- 64 символа и только латиница — человеческий текст туда не влезает и ломает
-- ссылку (подробности в services/support_link.py). Поэтому текст остаётся у
-- нас, а по ссылке едет короткий токен: бот по нему достаёт написанное и сразу
-- показывает и человеку, и нам. Так текст не теряется, даже если человек
-- дойдёт до бота через час.
--
-- ⚠️ Таблица ОБЩАЯ на весь проект, не только на услуги: тот же механизм нужен
-- в автонастройке и в техподдержке. Отличать случаи — полем `kind`.
CREATE TABLE IF NOT EXISTS bot_text_requests (
    id           SERIAL PRIMARY KEY,
    token        TEXT NOT NULL UNIQUE,       -- то, что уезжает в ссылку
    kind         TEXT NOT NULL DEFAULT 'service',
    text         TEXT NOT NULL,
    name         TEXT,
    contact_hint TEXT,                       -- телефон или почта, если человек оставил
    platform     TEXT,                       -- куда пошёл: telegram | max | vk
    client_id    INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    contact_id   INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    opened_at    TIMESTAMPTZ,                -- когда бот забрал текст
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_text_requests_kind ON bot_text_requests(kind, created_at DESC);

COMMENT ON TABLE bot_text_requests IS
    'Текст, написанный человеком на сайте, для передачи в бот по короткому токену.';
COMMENT ON COLUMN bot_text_requests.token IS
    'Только [A-Za-z0-9_-] и коротко: уезжает в ?start= Telegram, где лимит 64 символа.';

-- ── Права ────────────────────────────────────────────────────────────────
-- ⚠️⚠️ GRANT В ТОЙ ЖЕ МИГРАЦИИ. Миграции накатываются от postgres, он и
-- становится владельцем таблицы; приложение ходит под ролью plusson. Забыть
-- GRANT — значит получить `permission denied` и погасший экран целиком.
GRANT SELECT, INSERT, UPDATE, DELETE ON service_price_items TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_orders TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON bot_text_requests TO plusson;
GRANT USAGE, SELECT ON SEQUENCE service_price_items_id_seq TO plusson;
GRANT USAGE, SELECT ON SEQUENCE custom_orders_id_seq TO plusson;
GRANT USAGE, SELECT ON SEQUENCE bot_text_requests_id_seq TO plusson;
