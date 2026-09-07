-- 364. Разовые услуги + автонастройка Telegram «под ключ».
--
-- ЗАЧЕМ.
-- Клиент платит один раз, и за него делают всю базовую настройку Telegram:
-- создают бота, привязывают Mini App, заводят закрытую группу уведомлений,
-- добавляют туда бота, прописывают всё в кабинете и передают клиенту права.
-- Раньше это была ручная переписка с поддержкой на полчаса.
--
-- ⚠️ ПОЧЕМУ НОВАЯ СУЩНОСТЬ, А НЕ МОДУЛЬ-АДДОН.
-- Все существующие оплаты в проекте привязаны к СРОКУ: подписка, аддон
-- (client_addons.expires_at + months), заказ события, заказ продукта.
-- Услуга — разовая: «сделали и всё», у неё нет срока действия и её нельзя
-- «продлить». Положить её в client_addons значило бы, что через месяц у
-- клиента «истечёт настройка», которой давно нет. Отсюда своя пара таблиц.
--
-- Префикс номера заказа — svc-<id> (рядом с evt-, prd-, addon-).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Каталог разовых услуг
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS services (
    id              SERIAL PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    tagline         TEXT,                        -- строка под названием на витрине
    description     TEXT,
    bullet_points   JSONB DEFAULT '[]'::jsonb,   -- что входит, списком
    price           INTEGER NOT NULL DEFAULT 0,  -- рубли, как tariffs.price
    -- ⚠️ coming_soon=TRUE — карточка показывается БЕЗ кнопки оплаты.
    -- Тот же приём, что у модулей-аддонов (features.coming_soon).
    coming_soon     BOOLEAN NOT NULL DEFAULT TRUE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    -- Гейт: услуга видна только клиентам с этой фичей. NULL = всем.
    require_feature TEXT,
    leadpay_product_id TEXT,                     -- карточка товара в LeadPay
    prodamus_payment_url TEXT,
    sort            INTEGER NOT NULL DEFAULT 100,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE services IS
    'Разовые платные услуги ПЛЮСОНа (не подписка и не модуль — у них нет срока действия)';
COMMENT ON COLUMN services.coming_soon IS
    'TRUE — карточка видна, но купить нельзя (нет кнопки оплаты). Как features.coming_soon';
COMMENT ON COLUMN services.require_feature IS
    'Слаг фичи-гейта. Услуга видна только клиенту с этой фичей. NULL = видна всем';

-- ─────────────────────────────────────────────────────────────────────────
-- Аккаунты Telegram, от лица которых идёт автонастройка
-- ─────────────────────────────────────────────────────────────────────────
--
-- ⚠️ ПОЧЕМУ ОТДЕЛЬНАЯ ТАБЛИЦА, А НЕ channels.
-- channels — это БОТЫ (у них токен и Bot API). Здесь же живой аккаунт-человек,
-- работающий по MTProto через Telethon: у него телефон, пароль двухфакторки,
-- прокси и файл сессии. Общего с ботом — ничего.
--
-- ⚠️ ПОЧЕМУ ПАРОЛЬ ХРАНИТСЯ В БАЗЕ, А НЕ В ПЕРЕМЕННОЙ ОКРУЖЕНИЯ.
-- Аккаунтов несколько и они меняются (сгорел — завели новый). Пароль в .env
-- означал бы перевыпуск конфига и рестарт сервиса на каждую замену. Плюс
-- владелец должен видеть в админке телефон и пароль, чтобы зайти руками.
-- Таблица доступна только админу платформы.
CREATE TABLE IF NOT EXISTS tg_setup_accounts (
    id              SERIAL PRIMARY KEY,
    phone           TEXT NOT NULL UNIQUE,        -- без +, как в мейлере
    title           TEXT,                        -- пометка «Узбекистан, партия 02.09»
    username        TEXT,                        -- @ник аккаунта, заполняется сам
    tg_user_id      BIGINT,                      -- числовой id, заполняется сам
    twofa_password  TEXT,                        -- облачный пароль (нужен для передачи бота)
    proxy           TEXT,                        -- socks5://логин:пароль@хост:порт
    session_path    TEXT,                        -- путь к файлу сессии Telethon на сервере
    -- ⚠️ Сколько ботов аккаунт может держать ОДНОВРЕМЕННО. Ограничение Telegram —
    -- около 20 всего, но безопасный рабочий предел ниже. Слот освобождается
    -- не по времени, а когда бот передан клиенту.
    max_slots       INTEGER NOT NULL DEFAULT 5,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    -- Состояние по последней проверке @SpamBot:
    --   ok       — ограничений нет, можно работать
    --   limited  — спам-блок: BotFather отвечает «cannot create new bots»
    --   dead     — сессия мертва / аккаунт недоступен
    --   unknown  — ещё не проверяли
    health          TEXT NOT NULL DEFAULT 'unknown',
    health_note     TEXT,                        -- дословный ответ SpamBot
    health_checked_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tg_setup_accounts IS
    'Живые Telegram-аккаунты (Telethon), от лица которых создаются боты клиентов';
COMMENT ON COLUMN tg_setup_accounts.max_slots IS
    'Сколько непереданных ботов аккаунт держит одновременно. Слот освобождает передача бота клиенту';
COMMENT ON COLUMN tg_setup_accounts.health IS
    'ok | limited (спам-блок, ботов не создаёт) | dead (сессия мертва) | unknown';

-- ─────────────────────────────────────────────────────────────────────────
-- Заказы услуг + состояние автонастройки
-- ─────────────────────────────────────────────────────────────────────────
--
-- ⚠️ ЗАКАЗ И ПРОЦЕСС — ОДНА СТРОКА, А НЕ ДВЕ ТАБЛИЦЫ.
-- У услуги ровно один прогон настройки: заказ = процесс. Разносить их значило бы
-- на каждом экране джойнить две таблицы ради данных, которые всегда 1:1.
CREATE TABLE IF NOT EXISTS service_orders (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    service_id      INTEGER NOT NULL REFERENCES services(id),
    amount          INTEGER NOT NULL DEFAULT 0,  -- рубли на момент покупки

    -- Оплата
    -- created → paid → (дальше идёт настройка) ; failed / cancelled
    status          TEXT NOT NULL DEFAULT 'created',
    payment_provider TEXT,                       -- leadpay | prodamus | manual
    payment_order_num TEXT,                      -- номер у платёжной системы
    payment_raw     JSONB,
    paid_at         TIMESTAMPTZ,

    -- ─── Состояние автонастройки ───
    -- queued        — оплачено, ждём свободный слот
    -- running       — идёт настройка (создаём бота, группу)
    -- awaiting_user — всё сделано, ждём действий клиента (зайти в бота, вступить)
    -- done          — клиент забрал права, услуга закрыта
    -- expired       — не забрал за 3 дня, бот удалён; можно запустить заново
    -- failed        — сорвалось (например, имя бота заняли)
    setup_state     TEXT NOT NULL DEFAULT 'new',
    setup_error     TEXT,                        -- человеческим языком, показывается клиенту
    -- Живой лог шагов для экрана: [{at, step, ok, text}]
    setup_log       JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Что клиент попросил
    bot_username    TEXT,                        -- ник бота без @, проверен на занятость
    bot_title       TEXT,                        -- отображаемое имя бота

    -- Чем занимались и что получилось
    setup_account_id INTEGER REFERENCES tg_setup_accounts(id) ON DELETE SET NULL,
    bot_token       TEXT,                        -- пока не передан клиенту
    bot_channel_id  INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    group_chat_id   BIGINT,                      -- id созданной группы уведомлений
    group_invite_link TEXT,                      -- ссылка-приглашение для клиента
    client_tg_user_id BIGINT,                    -- узнаём, когда клиент напишет боту

    -- Галочки выполненных шагов (нужны, чтобы не повторять сделанное при перезапуске)
    bot_created_at      TIMESTAMPTZ,
    miniapp_linked_at   TIMESTAMPTZ,
    group_created_at    TIMESTAMPTZ,
    client_joined_at    TIMESTAMPTZ,             -- вступил в группу
    client_started_bot_at TIMESTAMPTZ,           -- написал боту /start
    bot_transferred_at  TIMESTAMPTZ,             -- права на бота у клиента
    group_transferred_at TIMESTAMPTZ,            -- права на группу у клиента
    channel_linked_at   TIMESTAMPTZ,             -- добавил бота в свой канал

    -- ⚠️ Срок «забрать бота». Ставится в момент, когда бот создан.
    -- Не забрал до этой даты — бот удаляется, слот освобождается,
    -- заказ переходит в expired. Оплата при этом НЕ сгорает:
    -- клиент запускает настройку заново без повторной оплаты.
    claim_deadline  TIMESTAMPTZ,
    reminders_sent  INTEGER NOT NULL DEFAULT 0,  -- сколько напоминаний уже ушло
    last_reminder_at TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE service_orders IS
    'Заказы разовых услуг. Для автонастройки здесь же живёт состояние процесса';
COMMENT ON COLUMN service_orders.setup_state IS
    'new | queued | running | awaiting_user | done | expired | failed';
COMMENT ON COLUMN service_orders.claim_deadline IS
    'До какого момента клиент должен забрать бота. Просрочил — бот удаляется, оплата остаётся';
COMMENT ON COLUMN service_orders.setup_log IS
    'Живой лог шагов для экрана клиента: [{at, step, ok, text}]';

CREATE INDEX IF NOT EXISTS idx_service_orders_client
    ON service_orders (client_id, created_at DESC);
-- Очередь: берём queued по времени оплаты.
CREATE INDEX IF NOT EXISTS idx_service_orders_queue
    ON service_orders (setup_state, paid_at)
    WHERE setup_state IN ('queued', 'running', 'awaiting_user');
-- Занятые слоты аккаунта считаются по непереданным ботам.
CREATE INDEX IF NOT EXISTS idx_service_orders_account_busy
    ON service_orders (setup_account_id)
    WHERE bot_transferred_at IS NULL AND setup_account_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Данные
-- ─────────────────────────────────────────────────────────────────────────

-- Фича-гейт: пока услуга видна только владельцу платформы (тариф admin).
INSERT INTO features (slug, name, description, is_addon)
     VALUES ('tg_autosetup',
             'Автонастройка Telegram',
             'Доступ к разделу «Автонастройка» в Каналах',
             FALSE)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'tg_autosetup'
ON CONFLICT DO NOTHING;

-- Сама услуга.
-- ⚠️ coming_soon=TRUE — на витрине видна, но КУПИТЬ НЕЛЬЗЯ: кнопки оплаты нет,
-- и бэкенд отказывает в заказе. Карточка LeadPay при этом уже прописана —
-- продажа открывается снятием галочки в админке, без релиза.
INSERT INTO services (slug, name, tagline, description, bullet_points, price,
                      coming_soon, require_feature, leadpay_product_id, sort)
     VALUES ('tg_autosetup',
             'Автонастройка ПЛЮСОНа и экспресс-подключение',
             'Настроим Telegram за вас — вам останется два нажатия',
             'Создаём вашего бота, привязываем к нему приложение, заводим закрытую группу для уведомлений и прописываем всё в кабинете. Вам останется только зайти в бота и вступить в группу — права мы передадим вам.',
             '["Бот с вашим названием — создадим и передадим вам",
               "Приложение внутри бота — подключим",
               "Закрытая группа для уведомлений — создадим и сделаем вас админом",
               "Все настройки в кабинете пропишем сами",
               "Подскажем, как подключить ваш канал"]'::jsonb,
             790,
             TRUE,
             'tg_autosetup',
             '66205',
             10)
ON CONFLICT (slug) DO NOTHING;

-- ⚠️ Роль `plusson` НЕ владелец таблиц (DDL на проде идёт от postgres).
-- Без грантов API получит «permission denied» на первом же запросе.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plusson') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE
           ON services, service_orders, tg_setup_accounts TO plusson;
        GRANT USAGE, SELECT
           ON services_id_seq, service_orders_id_seq, tg_setup_accounts_id_seq TO plusson;
    END IF;
END $$;

COMMIT;
