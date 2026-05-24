-- Миграция 105 (2026-05-24): Регистрация партнёров
--
-- Самостоятельная фича (не привязана к событию / лид-магниту): клиент даёт
-- ссылку на свой сторонний партнёрский лендинг (Tilda/GetCourse/Bizon360),
-- человек открывает её → попадает в бот клиента → авто-редирект на лендинг
-- с пробросом `pluson_cid` (наш contact_id) и `external_ref_param` рефовода
-- (партнёрский код во внешней системе клиента — строка key=value, например
-- "gcpc=fdd97"). После сабмита формы webhook /integrations/salebot/register
-- обновляет contacts.external_ref_param новому контакту → круг «гость →
-- партнёр» замыкается.
--
-- Сущности:
--   clients.partner_landing_url — URL стороннего лендинга клиента. NULL = фича
--                                  выключена (ссылки в UI замылены).
--   partner_runs                — каждое открытие ссылки на регистрацию
--                                  партнёра. Используется для:
--                                  · трекинга «кто привёл кого» (referrer_contact_id)
--                                  · хранения «хвоста» query-строки (external_ref_param
--                                    рефовода) до момента редиректа на лендинг
--                                  · poll-а экрана успеха в Mini App (видит code → ok)

BEGIN;

-- 1. URL стороннего партнёрского лендинга клиента
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS partner_landing_url TEXT;

COMMENT ON COLUMN clients.partner_landing_url IS
  'URL стороннего лендинга для регистрации партнёров (Tilda/GetCourse и т.п.). '
  'Если NULL — фича выключена, личные партнёрские ссылки в карточках контактов '
  'замылены. Mini App после открытия партнёрской ссылки делает '
  'window.location.replace на этот URL с pluson_cid + external_ref_param рефовода.';

-- 2. Забеги «регистрация партнёра»
CREATE TABLE IF NOT EXISTS partner_runs (
    id                     BIGSERIAL PRIMARY KEY,
    client_id              INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform_slug          TEXT NOT NULL REFERENCES platforms(slug),
    -- кто привёл (если ссылка персональная, иначе NULL = корневая ссылка клиента)
    referrer_contact_id    BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    -- «хвост» query-строки из ссылки рефовода — partner-код во внешней системе
    -- клиента (например "gcpc=fdd97"). Дописывается к URL лендинга через &.
    -- Может быть пустой строкой, если рефовод сам ещё не получил код.
    referrer_query         TEXT NOT NULL DEFAULT '',
    -- кто открыл ссылку (заполняется когда человек дошёл до бота)
    contact_id             BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    -- стадия: 'landed' (ссылку открыли) → 'opened_in_bot' (бот написал) →
    -- 'opened_landing' (Mini App кинул на форму) → 'completed' (webhook
    -- обновил contacts.external_ref_param)
    stage                  TEXT NOT NULL DEFAULT 'landed'
                           CHECK (stage IN ('landed', 'opened_in_bot', 'opened_landing', 'completed')),
    landed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    opened_in_bot_at       TIMESTAMPTZ,
    opened_landing_at      TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS partner_runs_client_idx     ON partner_runs(client_id);
CREATE INDEX IF NOT EXISTS partner_runs_contact_idx    ON partner_runs(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_runs_referrer_idx   ON partner_runs(referrer_contact_id) WHERE referrer_contact_id IS NOT NULL;

COMMIT;
