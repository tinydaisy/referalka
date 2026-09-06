-- 359: Автообзвоны — интеграция с сервисом Звонопёс (calldog.ru)
--
-- Клиент подключает СВОЙ аккаунт Звонопса (как платёжные системы, миграция 257):
-- ключ его, деньги за звонки его, ответственность перед ФАС его. Мы даём
-- интерфейс: выбрал аудиторию тем же фильтром, что в рассылках, — запустил обзвон.
--
-- ⚠️ Базу номеров сервису НЕ передаём и НЕ синхронизируем: у Звонопса нет
-- «загрузки базы» и она не нужна — номера уходят массивом `phones[]` прямо в
-- запросе на звонок. База остаётся у нас, туда уходит только список на этот
-- конкретный обзвон. Иначе неминуемо разъехались бы отписки: у нас человек
-- отказался от звонков, а у них он остался в старом списке.
--
-- ⚠️ Сценарий звонка («что говорит робот», нажатия, переадресация) живёт В ИХ
-- кабинете шаблоном, у него есть templateId. Мы шлём номера + templateId +
-- переменные. Свой редактор сценариев не строим: он дублировал бы их кабинет и
-- расходился бы с ним при каждом их изменении.
--
-- Гейт — фича `calls`, ТОЛЬКО admin (как partner_program). Клиентам не продаётся.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Ключ и настройки Звонопса на клиенте
-- ─────────────────────────────────────────────────────────────────────────────
-- Колонками прямо в clients — как pay_* (миграции 257/269/277). Отдельная
-- таблица не нужна: настройка одна на кабинет.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS calls_calldog_api_key TEXT;
-- Исходящий номер: без него звонок не создаётся. Либо конкретный номер
-- (outgoingPhone), либо calls_calldog_duty_phone=TRUE — тогда сервис сам берёт
-- случайный из дежурных (dutyPhone=1). Одно из двух обязательно.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS calls_calldog_outgoing_phone TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS calls_calldog_duty_phone BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN clients.calls_calldog_api_key IS
  'API-ключ Звонопса (calldog.ru). Выдаёт их менеджер, в кабинете не берётся.';
COMMENT ON COLUMN clients.calls_calldog_outgoing_phone IS
  'Номер, с которого звоним. Должен быть подтверждён в кабинете Звонопса.';
COMMENT ON COLUMN clients.calls_calldog_duty_phone IS
  'Брать случайный номер из дежурных вместо конкретного (dutyPhone=1).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Согласие на звонки
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ Колонки согласия на маркетинг УЖЕ ЕСТЬ (миграция 099: consent_marketing_at
-- /_ip/_policy_ver) — их не дублируем. Здесь заводится только ОТКАЗ ОТ ЗВОНКОВ.
--
-- Почему отдельная колонка, а не общий consent_marketing: галочка в форме одна
-- («согласен на рекламные материалы и звонки»), но отписаться человек вправе
-- от чего-то одного — отказался от писем, звонки остались, и наоборот.
-- Отписка от почты живёт в platform_user_channels.is_unsubscribed, а телефон
-- площадкой не является (в channels его нет) — значит нужно своё поле.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS calls_unsubscribed_at TIMESTAMPTZ;
COMMENT ON COLUMN contacts.calls_unsubscribed_at IS
  'Отказ от звонков. NULL = не отказывался. Ставится при нажатии «не звоните» '
  'в IVR или вручную. Отдельно от отписки по email.';

-- Частичный — отказавшихся мало, а фильтр по ним в каждом обзвоне.
CREATE INDEX IF NOT EXISTS idx_contacts_calls_unsub
  ON contacts (client_id) WHERE calls_unsubscribed_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Кампании обзвона
-- ─────────────────────────────────────────────────────────────────────────────
-- По мотивам broadcast_schedules, но своя таблица: у звонка нет текста и медиа,
-- зато есть сценарий, окно дозвона и повтор неответившим. Растягивать
-- broadcast_log.status ('sent'/'failed') на 'no_answer'/'busy' нельзя — это
-- разные исходы, и отчёт по рассылкам сломался бы.
CREATE TABLE IF NOT EXISTS call_campaigns (
    id            SERIAL PRIMARY KEY,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    -- NULL = обзвон по всей базе (общий), иначе — внутри события.
    event_id      INTEGER REFERENCES events(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,

    -- Что говорит робот: шаблон в кабинете Звонопса.
    template_id   INTEGER NOT NULL,

    -- Аудитория — те же поля, что у рассылок (миграции 018/265),
    -- чтобы фильтр выбирался ровно так же и хелперы переиспользовались.
    audience_include      TEXT,
    audience_exclude      TEXT,
    audience_tags_include TEXT[],
    audience_tags_exclude TEXT[],

    -- Когда звонить. fire_at nullable — у черновика даты может не быть.
    fire_at       TIMESTAMPTZ,
    -- Окно дозвона в МСК, строками "HH:MM" — как conf_sessions.start_time.
    -- Звонок в 7 утра — жалоба и штраф, поэтому окно задаётся всегда.
    start_time    TEXT,
    end_time      TEXT,
    weekdays      INTEGER[],
    -- Повтор неответившим через N минут (их smartDelay, 2..1440).
    smart_delay   INTEGER,

    status        TEXT NOT NULL DEFAULT 'draft',
    -- draft | pending | running | done | cancelled | failed

    -- Сколько номеров ушло в сервис и сколько отсеяно до отправки.
    targets_total INTEGER NOT NULL DEFAULT 0,
    skipped_no_phone   INTEGER NOT NULL DEFAULT 0,
    skipped_unsub      INTEGER NOT NULL DEFAULT 0,

    error_log     TEXT,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE call_campaigns IS
  'Кампания автообзвона через Звонопёс. Аналог broadcast_schedules для звонков.';

-- Поллер берёт по (fire_at, status) — как у рассылок.
CREATE INDEX IF NOT EXISTS idx_call_campaigns_fire
  ON call_campaigns (fire_at, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_call_campaigns_client
  ON call_campaigns (client_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Кто и с каким результатом
-- ─────────────────────────────────────────────────────────────────────────────
-- Результат звонка приходит ВЕБХУКОМ, отложенно (у рассылок такого нет вовсе,
-- кроме email-bounce): наш запрос → сервис звонит позже → результат прилетает.
-- Поэтому строка создаётся сразу при отправке со статусом 'queued'.
CREATE TABLE IF NOT EXISTS call_log (
    id            BIGSERIAL PRIMARY KEY,
    campaign_id   INTEGER NOT NULL REFERENCES call_campaigns(id) ON DELETE CASCADE,
    contact_id    INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    phone         TEXT NOT NULL,

    -- id звонка на стороне Звонопса — по нему сопоставляем вебхук.
    external_call_id TEXT,

    status        TEXT NOT NULL DEFAULT 'queued',
    -- queued | answered | no_answer | busy | failed | declined
    -- Их статусы: finished (поговорил) / canceled (не состоялся) / processed / created.

    -- Что человек нажал или сказал: ivrDigit / ivrAnswers из вебхука.
    -- Это главная ценность обзвона: «нажал 1 — интересно».
    ivr_answer    TEXT,
    -- Длительность разговора и стоимость — для отчёта клиенту.
    duration_sec  INTEGER,
    cost          NUMERIC(12,2),
    record_url    TEXT,

    error         TEXT,
    called_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE call_log IS
  'Результат по каждому номеру. Строка рождается при отправке (queued), '
  'финальный статус проставляет вебхук Звонопса.';

-- Вебхук приходит с их id звонка — ищем строку по нему.
CREATE INDEX IF NOT EXISTS idx_call_log_external
  ON call_log (external_call_id) WHERE external_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_log_campaign
  ON call_log (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_call_log_contact
  ON call_log (contact_id) WHERE contact_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Фича — ТОЛЬКО admin
-- ─────────────────────────────────────────────────────────────────────────────
-- Клиентам не продаётся: раздел новый, обзвон тратит реальные деньги и несёт
-- риск ФАС. Открыть клиентам = одна строка в tariff_features, без правок кода.
-- ⚠️ Триал зеркалит только фичи тарифа pro, поэтому к admin автозеркала не будет.
INSERT INTO features (slug, name, description, sort)
VALUES (
    'calls',
    'Автообзвоны',
    'Обзвон базы роботом через сервис Звонопёс: выбираете аудиторию как в '
    'рассылках, робот звонит и записывает, кто ответил и что нажал.',
    (SELECT COALESCE(MAX(sort), 0) + 1 FROM features)
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id
  FROM tariffs t, features f
 WHERE f.slug = 'calls' AND t.slug = 'admin'
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Права: роль plusson не владелец таблиц — без GRANT будет permission denied
-- ─────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON call_campaigns, call_log TO plusson;
GRANT USAGE, SELECT ON SEQUENCE call_campaigns_id_seq TO plusson;
GRANT USAGE, SELECT ON SEQUENCE call_log_id_seq TO plusson;

COMMIT;
