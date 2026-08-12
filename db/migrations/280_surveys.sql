-- 280: Анкеты + дополнительные поля контакта (2026-08-12)
--
-- Зачем. Клиент уходит с GetCourse, где анкеты были неудобны: чтобы анкету
-- заполнили, там приходилось собирать отдельную страницу с формой. У нас
-- анкета — сразу готовая ссылка (браузер + TG/VK/MAX), как у лид-магнитов.
--
-- ⚠️ Ключевое решение: поле анкеты и дополнительное поле контакта — ОДНА
-- сущность (`contact_fields`). «Доход», «Ниша», «Статус» — постоянные свойства
-- человека: живут в карточке, по ним фильтруется база и собирается сегмент для
-- рассылки. Анкета их просто заполняет. Два раздельных списка одного и того же
-- клиенту вести не придётся.
--
-- Анкета подарки НЕ выдаёт (решение владельца): выдача включается с другой
-- стороны — галочкой у лид-магнита/пакета. Поэтому зациклиться нечему.
-- Порядок в воронке: подписка на канал → анкета → файл.

-- ── Дополнительные поля контакта ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_fields (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    code        TEXT    NOT NULL,           -- машинное имя: income, niche, status
    title       TEXT    NOT NULL,           -- как видит клиент: «Уровень дохода»
    -- Файлов нет намеренно (решение владельца).
    kind        TEXT    NOT NULL DEFAULT 'text'
                CHECK (kind IN ('text','textarea','number','date','scale','select','multiselect','bool')),
    options     JSONB   NOT NULL DEFAULT '[]'::JSONB,  -- варианты для select/multiselect
    scale_min   SMALLINT,                   -- для kind='scale' (обычно 1)
    scale_max   SMALLINT,                   -- для kind='scale' (обычно 10)
    -- Показывать ли поле в карточке контакта. Ответы из анкеты пишутся всегда,
    -- но не всё стоит выносить в карточку — разовые вопросы там лишние.
    show_in_card BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, code)
);
CREATE INDEX IF NOT EXISTS idx_contact_fields_client ON contact_fields(client_id, sort_order, id);

-- Значение поля у конкретного человека — ТЕКУЩЕЕ (последнее известное).
-- ⚠️ Одна строка на (контакт, поле): карточка показывает актуальное значение,
-- а не историю. История ответов живёт в survey_answers — там видно, что и
-- когда человек отвечал в каждой анкете.
CREATE TABLE IF NOT EXISTS contact_field_values (
    id         SERIAL PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    field_id   INTEGER NOT NULL REFERENCES contact_fields(id) ON DELETE CASCADE,
    -- Текстовое представление — для показа и поиска. Для multiselect —
    -- варианты через запятую.
    value      TEXT,
    -- Машинное представление: число для number/scale, массив для multiselect,
    -- дата строкой ISO. Нужно для корректных фильтров и подсчётов.
    value_json JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (contact_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_cfv_field_value ON contact_field_values(field_id, value);
CREATE INDEX IF NOT EXISTS idx_cfv_contact ON contact_field_values(contact_id);

-- ── Анкеты ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveys (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    -- Короткий код ссылки pluson.ru/f/{slug} — как у лид-магнитов (/m/, /p/).
    slug        TEXT    NOT NULL UNIQUE,
    title       TEXT    NOT NULL,
    intro       TEXT,                        -- вводный текст над вопросами
    submit_label TEXT,                       -- текст кнопки, пусто → «Отправить»
    -- Что после отправки: 'thanks' — текст, 'url' — переход на свою ссылку.
    -- ⚠️ Выдачи подарка и регистрации на событие здесь НЕТ (решение владельца):
    -- подарок включается галочкой у самого лид-магнита.
    after_mode  TEXT    NOT NULL DEFAULT 'thanks' CHECK (after_mode IN ('thanks','url')),
    thanks_text TEXT,
    redirect_url TEXT,
    -- Можно ли заполнять повторно. FALSE → человеку показываем его прошлые
    -- ответы и не даём отправить второй раз.
    allow_repeat BOOLEAN NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_surveys_client ON surveys(client_id, id);

-- Вопрос анкеты. Либо привязан к полю контакта (ответ ляжет в карточку),
-- либо самостоятельный — тогда живёт только в отчёте по анкете.
CREATE TABLE IF NOT EXISTS survey_questions (
    id          SERIAL PRIMARY KEY,
    survey_id   INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    field_id    INTEGER REFERENCES contact_fields(id) ON DELETE SET NULL,
    title       TEXT    NOT NULL,
    hint        TEXT,
    kind        TEXT    NOT NULL DEFAULT 'text'
                CHECK (kind IN ('text','textarea','number','date','scale','select','multiselect','bool')),
    options     JSONB   NOT NULL DEFAULT '[]'::JSONB,
    scale_min   SMALLINT,
    scale_max   SMALLINT,
    is_required BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_questions_survey ON survey_questions(survey_id, sort_order, id);

-- Заполнение анкеты. Одна строка на попытку.
-- ⚠️ contact_id NULL быть не может: если человека нет в базе, он создаётся
-- при отправке (upsert_contact_with_identity) — как в остальных формах.
CREATE TABLE IF NOT EXISTS survey_responses (
    id          SERIAL PRIMARY KEY,
    survey_id   INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    -- Откуда пришёл: telegram/vk/max/web. Нужно, чтобы вернуть подарок в тот
    -- же мессенджер, из которого человек ушёл заполнять.
    platform_slug TEXT,
    -- За каким подарком шёл (если анкета открыта как шлагбаум перед выдачей).
    lead_magnet_id INTEGER REFERENCES lead_magnets(id) ON DELETE SET NULL,
    package_id     INTEGER REFERENCES lead_magnet_packages(id) ON DELETE SET NULL,
    utm         JSONB   NOT NULL DEFAULT '{}'::JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_survey_responses_contact ON survey_responses(contact_id, survey_id);

-- Ответ на конкретный вопрос.
CREATE TABLE IF NOT EXISTS survey_answers (
    id          SERIAL PRIMARY KEY,
    response_id INTEGER NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
    value       TEXT,
    value_json  JSONB,
    UNIQUE (response_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_survey_answers_question ON survey_answers(question_id);

-- ── Шлагбаум перед подарком ───────────────────────────────────────────────
-- ⚠️ По умолчанию NULL — анкета НЕ требуется (решение владельца): существующие
-- воронки продолжают работать как работали. Порядок: подписка → анкета → файл.
ALTER TABLE lead_magnets
    ADD COLUMN IF NOT EXISTS require_survey_id INTEGER REFERENCES surveys(id) ON DELETE SET NULL;
ALTER TABLE lead_magnet_packages
    ADD COLUMN IF NOT EXISTS require_survey_id INTEGER REFERENCES surveys(id) ON DELETE SET NULL;

-- ── Гранты (роль plusson НЕ владелец таблиц) ──────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    contact_fields, contact_field_values,
    surveys, survey_questions, survey_responses, survey_answers
    TO plusson;
GRANT USAGE, SELECT ON
    contact_fields_id_seq, contact_field_values_id_seq,
    surveys_id_seq, survey_questions_id_seq,
    survey_responses_id_seq, survey_answers_id_seq
    TO plusson;
