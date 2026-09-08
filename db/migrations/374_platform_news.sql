-- Новости платформы: админ (и сервисный клиент) публикует новость → клиенты
-- видят плашку вверху кабинета, колокольчик в шапке и страницу /dashboard/news.
--
-- ⚠️ Это НЕ рассылка клиента по его контактам (broadcast_schedules) — там
-- аудитория это `contacts` конкретного клиента. Здесь адресат — САМ КЛИЕНТ
-- платформы (строка в `clients`), как уведомления об истечении подписки и о
-- лимите контактов. Поэтому и своя пара таблиц, и своя отписка.
--
-- ⚠️ Статус draft/published — как у `products.status` (миграция 290), а не
-- флаг `is_active` (как у promotions): публикация здесь это событие, у неё
-- есть момент (published_at), от которого считается «новая для клиента».

CREATE TABLE IF NOT EXISTS platform_news (
    id              SERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL DEFAULT '',
    image_url       TEXT,                  -- только страница новостей; в плашку не лезет
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'published', 'archived')),
    published_at    TIMESTAMPTZ,           -- когда реально опубликовали (не created_at)

    -- Текст для рассылки. Пусто → берётся `body`: у большинства новостей текст
    -- один и тот же, заставлять писать дважды незачем.
    mail_subject    TEXT,
    mail_body       TEXT,

    -- Отметки отправки. Ставятся ДО попытки (как contact_limit_notified_kind):
    -- сбой на середине не должен разослать всё заново по второму кругу.
    email_sent_at   TIMESTAMPTZ,
    email_sent_count    INTEGER NOT NULL DEFAULT 0,
    bot_sent_at     TIMESTAMPTZ,
    bot_sent_count      INTEGER NOT NULL DEFAULT 0,

    created_by_admin_id  INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    created_by_client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN platform_news.published_at IS
  'Момент публикации. Непрочитанные считаются по нему, а не по created_at: черновик мог пролежать неделю.';
COMMENT ON COLUMN platform_news.mail_body IS
  'Текст для письма и бота. Пусто = берётся body.';
COMMENT ON COLUMN platform_news.image_url IS
  'Картинка новости. Показывается ТОЛЬКО на странице /dashboard/news и в письме — в плашку и колокольчик не помещается.';

-- Лента для клиента: только опубликованные, свежие сверху
CREATE INDEX IF NOT EXISTS idx_platform_news_published
    ON platform_news (published_at DESC)
    WHERE status = 'published';


-- Прочитанные: клиент × новость.
-- ⚠️ В БД, а не в localStorage (там сейчас живёт только dismiss плашки лимита
-- контактов): открыл кабинет с телефона — новости не должны всплыть заново.
CREATE TABLE IF NOT EXISTS platform_news_reads (
    news_id     INTEGER NOT NULL REFERENCES platform_news(id) ON DELETE CASCADE,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (news_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_news_reads_client
    ON platform_news_reads (client_id);


-- Отписка КЛИЕНТА от писем с новостями платформы.
-- ⚠️ Не путать с `platform_user_channels.is_unsubscribed` — там отписка
-- КОНТАКТА от рассылок его клиента. Клиент платформы контактом не является.
-- ⚠️ Отписка действует только на ПОЧТУ: в кабинете новости остаются (плашка,
-- колокольчик, страница), иначе человек просто перестанет узнавать о новом.
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS news_unsubscribed_at TIMESTAMPTZ;

COMMENT ON COLUMN clients.news_unsubscribed_at IS
  'Клиент отписался от писем с новостями ПЛЮСОНа. На показ новостей в кабинете не влияет.';


-- Роль plusson не владелец таблиц — без GRANT API получит permission denied
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_news, platform_news_reads TO plusson;
GRANT USAGE, SELECT ON SEQUENCE platform_news_id_seq TO plusson;
