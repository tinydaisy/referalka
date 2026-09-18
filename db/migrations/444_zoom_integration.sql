-- 444: Интеграция с Zoom — клиент подключает СВОЙ зум, конференция создаётся кнопкой.
--
-- Зачем. Сейчас связка «зум → наша вебинарная комната» собирается РУКАМИ и
-- каждый раз одинаково: завести конференцию, открыть её настройки, включить
-- Custom Live Streaming, вставить туда RTMP-адрес и ключ потока из вкладки
-- «Вебинар», скопировать ссылку входа обратно в поле
-- `webinar_rooms.speaker_join_url`. Четыре перекладывания строк между двумя
-- вкладками браузера, и любое можно сделать неверно — выяснится это в момент
-- старта эфира, когда комната окажется пустой.
--
-- ⚠️⚠️ ЗУМ У КАЖДОГО КЛИЕНТА СВОЙ. Конференции создаются в ЕГО аккаунте, а не
-- в аккаунте платформы: у Zoom лимит одновременных конференций на лицензию, и
-- эфиры чужих клиентов в нашем аккаунте мешали бы друг другу. Клиент проходит
-- обычный OAuth («Подключить Zoom» → окно Zoom → согласие), и сюда ложится его
-- токен. В окружении сервера лежат только ключи ПРИЛОЖЕНИЯ ПЛЮСОНа в Zoom
-- Marketplace (ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET) — одно приложение на всех,
-- ровно как у VK и Instagram.
--
-- Гейт — фича `zoom_integration`. Пока привязана только к скрытому тарифу
-- `admin` (обкатываем), приём тот же, что у `speakers_call` в 438/439.
-- Открыть клиентам = строка в tariff_features нужного тарифа, код не меняется.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Фича-гейт
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO features (slug, name, description, sort)
     VALUES ('zoom_integration',
             'Интеграция с Zoom',
             'Клиент подключает свой Zoom, и конференция на день эфира создаётся кнопкой: '
             'с трансляцией в вебинарную комнату и ссылкой входа для спикеров — без ручного '
             'переноса RTMP-адреса и ключа.',
             206)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE t.slug = 'admin' AND f.slug = 'zoom_integration'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Подключённый зум-аккаунт клиента
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ ОТДЕЛЬНАЯ ТАБЛИЦА, а не `channels`. Channels — это площадки общения с
-- аудиторией (TG/VK/MAX/Instagram): у них есть подписчики, главный канал на
-- платформу, рассылки. Zoom ничего этого не имеет — это инструмент проведения
-- эфира. В channels он тянул бы за собой чужие правила (триггер «один активный
-- на платформу», привязку через client_channels) ради полей, которых у него нет.
--
-- ⚠️ Один аккаунт на клиента (UNIQUE client_id): конференции создаются там, где
-- у клиента лицензия, и выбор «в каком из двух зумов» не нужен никому.
CREATE TABLE IF NOT EXISTS client_zoom_accounts (
    id                 SERIAL PRIMARY KEY,
    client_id          INTEGER NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,

    -- Кто подключён — показываем в кабинете, чтобы человек видел, ЧЕЙ зум привязан
    zoom_user_id       TEXT,
    zoom_email         TEXT,
    zoom_account_name  TEXT,
    -- Тип лицензии Zoom: 1 — базовый (бесплатный), 2 — Pro, 3 — Business и выше.
    -- ⚠️ Ниже Pro нет Custom Live Streaming: конференция создастся, а вещать в
    -- нашу комнату не сможет. Знать это нужно ДО эфира, поэтому храним.
    zoom_plan_type     INTEGER,

    -- ⚠️ Токены открытым текстом — как `channels.bot_token` и токены Instagram
    -- по всему проекту. Отдельного шифрования в проекте нет вовсе; заводить его
    -- ради одной таблицы значит держать ключ шифрования рядом с данными и
    -- делать вид, что стало безопаснее. Защита — доступ к базе и GRANT-ы.
    access_token       TEXT,
    refresh_token      TEXT,
    -- ⚠️ access живёт 1 час, refresh — 15 лет, НО Zoom выдаёт новый refresh при
    -- каждом обмене и гасит старый. Поэтому при обновлении записываем ОБА.
    token_expires_at   TIMESTAMPTZ,

    -- Последняя неудача обновления токена: клиент отозвал доступ, удалил
    -- приложение. Кабинет по этому полю говорит «подключите заново», а не
    -- молчит до первого эфира.
    refresh_failed_at  TIMESTAMPTZ,
    refresh_error      TEXT,

    -- Незавершённое подключение: человек нажал «Подключить», но из окна Zoom
    -- ещё не вернулся. ⚠️ Здесь же, а не в отдельной таблице: строка на клиента
    -- всё равно одна, и хранить «полшага OAuth» рядом с результатом проще, чем
    -- заводить таблицу, живущую десять минут.
    pending_state      TEXT,
    pending_state_exp  TIMESTAMPTZ,

    connected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ⚠️ Поиск по state при возврате из Zoom: callback приходит БЕЗ авторизации
-- (Zoom наши куки не пересылает), и клиент опознаётся только по нему.
CREATE INDEX IF NOT EXISTS idx_client_zoom_pending_state
    ON client_zoom_accounts(pending_state) WHERE pending_state IS NOT NULL;

COMMENT ON TABLE client_zoom_accounts IS
  'Зум-аккаунт клиента, подключённый по OAuth. Конференции создаются в НЁМ, не в аккаунте платформы';
COMMENT ON COLUMN client_zoom_accounts.refresh_token IS
  '⚠️ Zoom выдаёт НОВЫЙ refresh при каждом обмене и гасит прежний — перезаписывать обязательно';

-- ⚠️ GRANT в той же миграции: миграции идут от postgres, он и становится
-- владельцем таблицы, а приложение ходит под ролью plusson. Без этого любой
-- запрос отвечает «permission denied» → 500 в кабинете.
GRANT SELECT, INSERT, UPDATE, DELETE ON client_zoom_accounts TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_zoom_accounts_id_seq TO plusson;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Какая конференция создана у дня эфира
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Поля на webinar_rooms, а НЕ на events: зум-конференция заводится под
-- конкретный эфир, у двух дней программы — две разные конференции. Ровно по
-- той же причине рядом живёт speaker_join_url (миграция 433).
--
-- ⚠️ speaker_join_url НЕ дублируем: ссылка входа спикера остаётся в своём поле.
-- Кнопка её заполняет, человек может поправить руками — и действует то, что в
-- поле. Второе «настоящее» место для той же ссылки означало бы вопрос «какая
-- из двух действует», а ответа на него нет.
ALTER TABLE webinar_rooms
  ADD COLUMN IF NOT EXISTS zoom_meeting_id    TEXT,       -- id конференции в Zoom (числовой, но храним строкой: длиннее int4)
  ADD COLUMN IF NOT EXISTS zoom_start_url     TEXT,       -- ссылка ЗАПУСКА для ведущего (с ZAK-токеном, живёт ~2 часа)
  ADD COLUMN IF NOT EXISTS zoom_password      TEXT,       -- код доступа конференции (Zoom ставит его сам)
  ADD COLUMN IF NOT EXISTS zoom_livestream_ok BOOLEAN NOT NULL DEFAULT FALSE,  -- удалось ли включить вещание на наш RTMP
  ADD COLUMN IF NOT EXISTS zoom_created_at    TIMESTAMPTZ;

COMMENT ON COLUMN webinar_rooms.zoom_meeting_id IS
  'ID конференции Zoom, созданной кнопкой из кабинета. NULL — конференцию не создавали';
COMMENT ON COLUMN webinar_rooms.zoom_start_url IS
  '⚠️ Ссылка ЗАПУСКА для ведущего (start_url, с ZAK-токеном). НЕ давать спикерам и зрителям: '
  'открывший её становится владельцем конференции. Спикеры идут по speaker_join_url';
COMMENT ON COLUMN webinar_rooms.zoom_livestream_ok IS
  'TRUE — Zoom принял настройку Custom Live Streaming на наш RTMP. FALSE — конференция создана, '
  'но в комнату вещать не будет (чаще всего у аккаунта тариф ниже Pro)';

COMMIT;
