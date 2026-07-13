-- 217. Библиотека дефолтных шаблонов рассылок — из кода в БД (админка).
--
-- ЗАЧЕМ. Дефолтные тексты шаблонов были захардкожены в DEFAULT_TEMPLATES
-- (backend/app/api/modules/broadcasts.py). Из этого списка шаблоны копируются
-- клиенту при создании события (авто-сид) и по кнопке «Добавить шаблон»
-- (пресеты). Поменять текст мог только разработчик; в дефолтах накопились
-- расхождения (шаблон «За 5 минут до выступления спикера» не упоминал спикера,
-- VIP-оффер содержал личные ссылки одного клиента).
--
-- Теперь библиотека живёт здесь, а админка её редактирует. Правило:
--   • НОВЫЕ события и кнопка «Добавить шаблон» берут тексты отсюда;
--   • УЖЕ созданные события НЕ трогаются — там свои правки клиента
--     (broadcast_templates), перезатирать их нельзя.
--
-- Принадлежность модулям (раньше — клубок if-ов EVENT_ONLY_TYPES /
-- TURNIR_EXTRA_TYPES) стала тремя явными флагами.

CREATE TABLE IF NOT EXISTS default_broadcast_templates (
    id              SERIAL PRIMARY KEY,
    type            TEXT NOT NULL,        -- 5min_before, gift, day_live, …
    name            TEXT NOT NULL,
    subject         TEXT,                 -- тема письма / первая жирная строка
    text            TEXT NOT NULL,
    -- Альтернативный текст для события БЕЗ программы по дням (мероприятие):
    -- в нём нет {day_program}. NULL → берётся общий text.
    text_event      TEXT,
    photo_url       TEXT,
    button_text     TEXT,
    button_url      TEXT,

    schedule_mode        TEXT NOT NULL DEFAULT 'fixed_offset',
    offset_minutes       INT  NOT NULL DEFAULT 0,
    audience_include     TEXT NOT NULL DEFAULT 'all_event',
    audience_exclude     TEXT NOT NULL DEFAULT 'none',
    allow_custom_datetime BOOLEAN NOT NULL DEFAULT FALSE,

    -- К каким модулям относится шаблон (заменяет захардкоженные списки).
    for_event       BOOLEAN NOT NULL DEFAULT FALSE,  -- обычное мероприятие
    for_conference  BOOLEAN NOT NULL DEFAULT FALSE,
    for_turnir      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Сидится автоматически при создании события (иначе только в «Добавить шаблон»).
    autoseed        BOOLEAN NOT NULL DEFAULT TRUE,
    -- Таких шаблонов у события может быть несколько (vip_offer, expert_day) —
    -- не прячем из списка пресетов, даже если один уже добавлен.
    multi_instance  BOOLEAN NOT NULL DEFAULT FALSE,

    -- Переопределения названия/текста для турнира (там «событие», а не «конференция»).
    turnir_name     TEXT,
    turnir_text     TEXT,

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Один шаблон на тип (тип — ключ, по которому движок рассылок понимает смысл).
CREATE UNIQUE INDEX IF NOT EXISTS default_broadcast_templates_type_uniq
    ON default_broadcast_templates (type);

GRANT SELECT, INSERT, UPDATE, DELETE ON default_broadcast_templates TO plusson;
GRANT USAGE, SELECT ON SEQUENCE default_broadcast_templates_id_seq TO plusson;
