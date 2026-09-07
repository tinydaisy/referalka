-- 363: Формы заявки (решение владельца 07.09.2026)
--
-- Заявка = человек НЕ регистрируется и НЕ платит: заполняет анкету и получает
-- «с вами свяжутся». Ответ падает в заявки анкеты со всей готовой обвязкой
-- («Обработано», счётчик необработанных, уведомления, CRM, выгрузка).
--
-- ⚠️ ОТДЕЛЬНОЙ СУЩНОСТИ «ЗАЯВКА» НЕТ — это анкета. Здесь только связка
-- «у этого события/продукта заявки собирает вот эта анкета».
--
-- ⚠️ ПОЛИМОРФНО, как event_landing_pages (миграция 293): блок анкеты обязан
-- работать во ВСЕХ видах лендингов ПЛЮСОНа, значит и форма заявки нужна и
-- событию, и продукту.
--
-- ⚠️ ОДНА ФОРМА НА ВЛАДЕЛЬЦА (UNIQUE ниже): кнопка участия одна, при двух
-- формах непонятно, какую открывать. Разные наборы вопросов — это разные
-- анкеты, их и так сколько угодно.

CREATE TABLE IF NOT EXISTS request_forms (
    id            SERIAL PRIMARY KEY,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    owner_type    TEXT    NOT NULL CHECK (owner_type IN ('event', 'product')),
    owner_id      INTEGER NOT NULL,

    -- ⚠️ ON DELETE RESTRICT: анкета — источник заявок, и молча оставить форму
    -- без анкеты нельзя (лендинг показал бы пустую секцию). Сначала отвяжи
    -- форму, потом удаляй анкету.
    survey_id     INTEGER NOT NULL REFERENCES surveys(id) ON DELETE RESTRICT,

    -- Заголовок и подпись — то, что человек видит над вопросами. Пусто →
    -- фронт подставит дефолт («Оставить заявку»).
    title         TEXT,
    subtitle      TEXT,
    -- Что показать ПОСЛЕ отправки. Пусто → «Спасибо, с вами свяжутся».
    success_text  TEXT,

    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Одна форма на владельца.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_request_forms_owner
    ON request_forms (owner_type, owner_id);

CREATE INDEX IF NOT EXISTS idx_request_forms_client
    ON request_forms (client_id);

-- ⚠️ Роль plusson не владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON request_forms TO plusson;
GRANT USAGE, SELECT ON SEQUENCE request_forms_id_seq TO plusson;
