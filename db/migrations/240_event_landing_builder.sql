-- 240: Конструктор лендинга события (раздел «Лендинг» в карточке мероприятия).
--
-- Зачем. Клиент собирает продающую страницу события из готовых блоков, не уходя
-- в Tilda/GetCourse. Ключевое отличие от стороннего лендинга (events.landing_url):
-- блоки «спикеры», «программа», «тарифы», «организатор» НЕ хранят копию контента —
-- они тянут живые данные события. Поправил спикера в кабинете → на лендинге
-- обновилось само. Руками задаётся только то, чего в базе нет (миссия, ценности,
-- цифры, «чем отличаемся»).
--
-- Две страницы на событие (`event_landing_pages.kind`):
--   main       — основная страница лендинга,  pluson.ru/e/{slug}
--   post_pay   — страница после оплаты,       pluson.ru/e/{slug}/thanks
-- На post_pay ведёт `event_tariffs.pay_url` (клиент ставит её как return-url в
-- платёжке). Там — сопроводительный текст + кнопки на подключённых ботов клиента,
-- чтобы человек не потерялся после оплаты.
--
-- Гейт — по ФИЧЕ `event_landing` (правило: гейтить только по фичам, никогда по
-- tariff_slug). Выдаётся тарифу «Администратор» (admin), как email_broadcasts.
-- ⚠️ Триал всегда зеркалит pro: если фичу позже привяжут к pro — не забыть про trial
-- (_mirror_pro_features_to_trial в admin.py делает это сам при правке через админку).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Страница лендинга + её оформление (одна тема на страницу)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_landing_pages (
    id              SERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL DEFAULT 'main'
                    CHECK (kind IN ('main', 'post_pay')),
    is_published    BOOLEAN NOT NULL DEFAULT FALSE,  -- FALSE = черновик, публично не отдаём

    -- Оформление страницы целиком.
    bg_color        TEXT,           -- фон страницы, #RRGGBB
    bg_image_url    TEXT,           -- фоновая картинка страницы
    bg_overlay      TEXT,           -- цвет перекрытия поверх картинки
    bg_overlay_opacity SMALLINT NOT NULL DEFAULT 60
                    CHECK (bg_overlay_opacity BETWEEN 0 AND 100),

    font_heading    TEXT NOT NULL DEFAULT 'Manrope',   -- ключ из FONTS (landing_fonts.py)
    font_body       TEXT NOT NULL DEFAULT 'Manrope',
    color_heading   TEXT NOT NULL DEFAULT '#0a1520',
    color_body      TEXT NOT NULL DEFAULT '#25455D',

    btn_color       TEXT NOT NULL DEFAULT '#FFCFA4',
    btn_text_color  TEXT NOT NULL DEFAULT '#0a1520',
    btn_metallic    BOOLEAN NOT NULL DEFAULT FALSE,    -- галочка «металлический градиент»

    icon_color      TEXT NOT NULL DEFAULT '#FFCFA4',
    icon_metallic   BOOLEAN NOT NULL DEFAULT FALSE,

    -- Только для kind='post_pay': сопроводительный текст над кнопками ботов.
    post_pay_title  TEXT,
    post_pay_text   TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (event_id, kind)   -- одна основная + одна пост-оплатная на событие
);
CREATE INDEX IF NOT EXISTS idx_event_landing_pages_event
    ON event_landing_pages(event_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Блоки страницы — порядок задаётся перетаскиванием (sort_order)
-- ─────────────────────────────────────────────────────────────────────────────
-- `kind` — свободный TEXT без CHECK (как у webinar_blocks): добавить новый тип
-- блока можно кодом, без миграции. Действующие типы:
--   hero        — шапка: название, подзаголовок, даты, кнопка регистрации
--   seats       — «осталось мест» (свободные считаются, не хранятся)
--   gifts       — подарки за регистрацию (из реф-программы события)
--   benefits    — «что получите на событии», список пунктов
--   values      — «наши ценности»
--   mission     — «наша миссия»
--   numbers     — 2–4 цифры с подписями (формат как регалии основателя: {value, label})
--   difference  — «чем отличаемся от других»
--   speakers    — спикеры события (живые данные)
--   organizer   — организатор: бренд и основатель (живые данные)
--   program     — программа (живые данные)
--   tariffs     — тарифы с кнопками оплаты (живые данные)
--   text        — произвольная секция: заголовок + содержимое
--   gallery     — галерея/отзывы. Режим в items.mode: carousel | grid, тип в
--                 items.media: image | video. Сами элементы — items.list:
--                 [{url, caption}] (для video url = ссылка YouTube/VK/Rutube).
--                 Таких блоков можно добавить сколько угодно (отзывы, фото и т.д.)
--   support     — «Есть вопросы?» → кнопки связи с техподдержкой клиента
--                 (clients.work_tg_username / work_vk / work_max — живые данные)
--   footer      — подвал: реквизиты (clients.legal_*), ссылка на политику
--                 (/c/{client_id}/privacy), оферта (events.offer_url), контакты.
--                 Всё живое — заполняется в Настройках, здесь не дублируется.
CREATE TABLE IF NOT EXISTS event_landing_blocks (
    id            SERIAL PRIMARY KEY,
    page_id       INTEGER NOT NULL REFERENCES event_landing_pages(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,   -- галочка «показывать блок»

    title         TEXT,      -- заголовок секции
    subtitle      TEXT,      -- подзаголовок
    body          TEXT,      -- содержимое (текст секции)
    button_label  TEXT,      -- подпись кнопки, если у блока есть кнопка
    button_url    TEXT,      -- пусто у hero/tariffs — ведут на регистрацию/оплату сами

    -- Списочное содержимое: benefits → ["пункт", ...],
    -- numbers → [{value, label}], seats → {total: N}.
    items         JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Оформление конкретной секции (перекрывает страницу, NULL = как у страницы).
    bg_color         TEXT,
    bg_image_url     TEXT,
    bg_overlay       TEXT,
    bg_overlay_opacity SMALLINT CHECK (bg_overlay_opacity BETWEEN 0 AND 100),
    border_color     TEXT,
    border_width     SMALLINT NOT NULL DEFAULT 0 CHECK (border_width BETWEEN 0 AND 12),
    border_radius    SMALLINT NOT NULL DEFAULT 0 CHECK (border_radius BETWEEN 0 AND 64),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_landing_blocks_page
    ON event_landing_blocks(page_id, sort_order);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Лимит мест — на событии, а не в блоке
-- ─────────────────────────────────────────────────────────────────────────────
-- Блок `seats` показывает «осталось N из M». M задаёт клиент здесь; занятые
-- считаются на лету по event_participants (is_registered=TRUE) — хранить нечего,
-- иначе цифра разъедется с реальностью.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS seats_total INTEGER;

COMMENT ON COLUMN events.seats_total IS
  'Всего мест на событии. NULL = без лимита. Свободные = seats_total - зарегистрированные.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Фича доступа
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO features (slug, name, description, sort)
VALUES (
    'event_landing',
    'Конструктор лендинга события',
    'Раздел «Лендинг» в карточке события: страница собирается из блоков, '
    'спикеры/программа/тарифы подтягиваются автоматически.',
    91
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'event_landing'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Права (роль plusson — не владелец таблиц, DDL на проде только под postgres)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages  TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_blocks TO plusson;
GRANT USAGE, SELECT ON SEQUENCE event_landing_pages_id_seq   TO plusson;
GRANT USAGE, SELECT ON SEQUENCE event_landing_blocks_id_seq  TO plusson;
