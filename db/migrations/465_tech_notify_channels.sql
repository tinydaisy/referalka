-- 465. Уведомления внедренцу: личка + отдельная группа, ОБА канала сразу.
--
-- ⚠️⚠️ ШЛЁМ В ДВА МЕСТА, А НЕ В ОДНО (решение владельца 19.09.2026). Личка —
-- чтобы менеджер увидел сразу; группа — чтобы не пропустил и чтобы видели
-- коллеги. Выбор «или-или» здесь неверен: у личного сообщения свойство
-- «увидит быстро», у группы — «не потеряется», нужны оба.
--
-- ⚠️ @pluson_bot ОБЩИЙ НА ВСЕХ, и это не мешает личным уведомлениям: внутри
-- бота у каждого человека свой чат по его telegram_user_id. Внедренец один раз
-- заходит по ссылке с подписанным токеном — связка запоминается, и дальше ему
-- приходит ТОЛЬКО по его клиентам. Отдельного бота на внедренца заводить не
-- надо.
--
-- ⚠️ Группа — отдельная, а не общий канал оплат владельца: там уведомления по
-- всей платформе, и свои клиенты в них теряются.

ALTER TABLE tech_specialists
    -- Личка в @pluson_bot: id чата человека. Заполняется САМ, когда внедренец
    -- переходит по ссылке из кабинета, — руками его вводить не нужно и нельзя
    -- (чужой id значил бы уведомления не тому).
    ADD COLUMN IF NOT EXISTS notify_tg_user_id TEXT,
    ADD COLUMN IF NOT EXISTS notify_tg_linked_at TIMESTAMPTZ,
    -- Группа уведомлений: id вводит сам внедренец (создал группу, добавил
    -- нашего бота, взял id командой /getmyid).
    ADD COLUMN IF NOT EXISTS notify_chat_id TEXT,
    -- Какие события слать. ⚠️ JSONB, а не колонка на каждый вид: виды
    -- уведомлений будут добавляться, и каждый раз менять схему — лишнее.
    ADD COLUMN IF NOT EXISTS notify_kinds JSONB NOT NULL DEFAULT
        '["question","lead","trial","payment","expiring","expired"]'::jsonb;

COMMENT ON COLUMN tech_specialists.notify_tg_user_id IS
    'Личный чат внедренца в @pluson_bot. Ставится автоматически по ссылке-связке.';
COMMENT ON COLUMN tech_specialists.notify_chat_id IS
    'Группа уведомлений внедренца. Шлём И сюда, И в личку — чтобы не пропустил.';
COMMENT ON COLUMN tech_specialists.notify_kinds IS
    'Виды событий: question, lead, trial, payment, expiring, expired.';

-- ── Ответ клиенту РЕПЛАЕМ из бота ────────────────────────────────────────
-- ⚠️⚠️ МЕНЕДЖЕР РАБОТАЕТ ИЗ БОТА, А НЕ ИЗ КАБИНЕТА (владелец, 19.09.2026).
-- Значит уведомление о вопросе клиента — не сигнал «сходи в кабинет», а
-- рабочее место: менеджер отвечает на него реплаем, и текст уходит клиенту на
-- его площадку.
--
-- Чтобы это работало, надо помнить, КОМУ отвечать: на какое сообщение в каком
-- чате пришёл реплай → какой это контакт и какая площадка.
CREATE TABLE IF NOT EXISTS tech_notify_messages (
    id         SERIAL PRIMARY KEY,
    spec_id    INTEGER NOT NULL REFERENCES tech_specialists(id) ON DELETE CASCADE,
    chat_id    TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    client_id  INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    platform   TEXT NOT NULL DEFAULT 'telegram',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Пара «чат + сообщение» уникальна: по ней и ищем при реплае.
    UNIQUE (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS ix_tech_notify_messages_spec
    ON tech_notify_messages (spec_id, created_at DESC);

COMMENT ON TABLE tech_notify_messages IS
    'На какое уведомление можно ответить реплаем и кому уйдёт ответ.';

-- ⚠️⚠️ GRANT В ТОЙ ЖЕ МИГРАЦИИ: миграции накатываются от postgres, он и
-- становится владельцем таблицы, а приложение ходит под ролью plusson. Забыть
-- GRANT — значит получить `permission denied` и погасший экран целиком.
GRANT SELECT, INSERT, UPDATE, DELETE ON tech_notify_messages TO plusson;
GRANT USAGE, SELECT ON SEQUENCE tech_notify_messages_id_seq TO plusson;
