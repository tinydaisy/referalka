-- ═══════════════════════════════════════════
-- PLUSSON — Схема базы данных MVP
-- Версия: 1.0  Дата: 2026-03
-- ═══════════════════════════════════════════

-- ─────────────────────────────────────────
-- ТАРИФЫ
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tariffs (
  id                SERIAL PRIMARY KEY,
  slug              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  price             NUMERIC(10,2) DEFAULT 0,
  trial_months      INT DEFAULT 12,
  max_events        INT DEFAULT -1,       -- -1 = безлимит
  max_participants  INT DEFAULT -1,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- МОДУЛИ ПЛАТФОРМЫ
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   BOOLEAN DEFAULT TRUE
);

-- ─────────────────────────────────────────
-- ПАРТНЁРЫ СЕРВИСА (приводят клиентов в PLUSSON)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  partner_code  TEXT UNIQUE NOT NULL,
  percent       NUMERIC(5,2) DEFAULT 0,
  contact       TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- КЛИЕНТЫ PLUSSON
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id                SERIAL PRIMARY KEY,
  auth_user_id      UUID,
  name              TEXT NOT NULL,
  email             TEXT UNIQUE NOT NULL,
  phone             TEXT,
  telegram_username TEXT,
  password_hash     TEXT,
  bot_token         TEXT,
  tariff_slug       TEXT REFERENCES tariffs(slug) DEFAULT 'beta',
  trial_ends_at     TIMESTAMPTZ,
  partner_code      TEXT REFERENCES partners(partner_code),
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- АДМИНИСТРАТОРЫ ПЛАТФОРМЫ
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  is_superadmin BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ПОДКЛЮЧЁННЫЕ МОДУЛИ КЛИЕНТА
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_modules (
  id          SERIAL PRIMARY KEY,
  client_id   INT REFERENCES clients(id) ON DELETE CASCADE,
  module_slug TEXT REFERENCES modules(slug),
  enabled_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, module_slug)
);

-- ─────────────────────────────────────────
-- СОБЫТИЯ
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id                    SERIAL PRIMARY KEY,
  client_id             INT REFERENCES clients(id) ON DELETE CASCADE,
  slug                  TEXT UNIQUE NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  landing_url           TEXT,
  webhook_url           TEXT,
  module_slug           TEXT REFERENCES modules(slug) DEFAULT 'base',
  points_free           INT DEFAULT 1,
  points_paid           INT DEFAULT 0,
  points_scope          TEXT DEFAULT 'event',  -- 'event' | 'client'
  require_subscription  BOOLEAN DEFAULT FALSE,
  status                TEXT DEFAULT 'draft',  -- draft | active | ended
  poster_url            TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ТРЕБОВАНИЯ ПОДПИСКИ (мессенджер-агностик)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id            SERIAL PRIMARY KEY,
  event_id      INT REFERENCES events(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,    -- 'telegram' | 'max' | ...
  channel_id    TEXT NOT NULL,
  channel_title TEXT,
  is_required   BOOLEAN DEFAULT TRUE
);

-- ─────────────────────────────────────────
-- ГЛОБАЛЬНЫЙ РЕЕСТР TELEGRAM-ПОЛЬЗОВАТЕЛЕЙ
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telegram_users (
  id          SERIAL PRIMARY KEY,
  tg_id       BIGINT UNIQUE NOT NULL,
  username    TEXT,
  first_name  TEXT,
  last_name   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- УЧАСТИЕ В СОБЫТИИ (Many-to-Many)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_participants (
  id                      SERIAL PRIMARY KEY,
  event_id                INT REFERENCES events(id) ON DELETE CASCADE,
  tg_user_id              BIGINT REFERENCES telegram_users(tg_id),
  referrer_participant_id INT REFERENCES event_participants(id),
  ref_code                TEXT UNIQUE NOT NULL,
  ref_code_paid           TEXT UNIQUE,
  referrer_ref_code       TEXT,
  points_total            INT DEFAULT 0,
  registered_at           TIMESTAMPTZ DEFAULT NOW(),
  activated_at            TIMESTAMPTZ,
  UNIQUE(event_id, tg_user_id)
);

-- ─────────────────────────────────────────
-- МНОГОУРОВНЕВЫЕ БАЛЛЫ (заложено, не MVP)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_levels (
  id          SERIAL PRIMARY KEY,
  event_id    INT REFERENCES events(id) ON DELETE CASCADE,
  level       INT NOT NULL,
  points_free INT DEFAULT 0,
  points_paid INT DEFAULT 0
);

-- ─────────────────────────────────────────
-- РЕФЕРАЛЬНЫЕ СОБЫТИЯ (клики и конверсии)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_events (
  id              SERIAL PRIMARY KEY,
  event_id        INT REFERENCES events(id),
  ref_code        TEXT NOT NULL,
  visitor_tg_id   BIGINT,
  type            TEXT NOT NULL,   -- 'click' | 'free' | 'paid'
  points_awarded  INT DEFAULT 0,
  level           INT DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ПОДАРКИ / ПРИЗЫ (каталог, оплата баллами)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gifts (
  id          SERIAL PRIMARY KEY,
  event_id    INT REFERENCES events(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  points_cost INT NOT NULL,
  link_url    TEXT,
  stock       INT DEFAULT -1,   -- -1 = безлимит
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- МАТЕРИАЛЫ (бесплатные: события, уроки, записи)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS materials (
  id          SERIAL PRIMARY KEY,
  event_id    INT REFERENCES events(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  link_url    TEXT,
  type        TEXT DEFAULT 'free',   -- 'free' | 'paid'
  gift_id     INT REFERENCES gifts(id),
  is_eternal  BOOLEAN DEFAULT FALSE,
  status      TEXT DEFAULT 'active', -- 'active' | 'archived'
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ВЫДАЧА ПОДАРКОВ
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gift_issuances (
  id              SERIAL PRIMARY KEY,
  gift_id         INT REFERENCES gifts(id),
  participant_id  INT REFERENCES event_participants(id),
  status          TEXT DEFAULT 'pending',  -- 'pending' | 'issued'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ЛОГ УВЕДОМЛЕНИЙ
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications_log (
  id          SERIAL PRIMARY KEY,
  event_id    INT REFERENCES events(id),
  tg_user_id  BIGINT REFERENCES telegram_users(tg_id),
  segment     TEXT,   -- 'no_game' | 'no_share' | 'stalled'
  message     TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────
-- ПРОМО-МАТЕРИАЛЫ (афиши, тексты анонсов)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_materials (
  id          SERIAL PRIMARY KEY,
  event_id    INT REFERENCES events(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,   -- 'poster' | 'text' | 'link'
  title       TEXT,
  content     TEXT,
  file_url    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════
-- МОДУЛЬ «КОНФЕРЕНЦИЯ» (module_slug = 'conference')
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conf_conferences (
  id                    SERIAL PRIMARY KEY,
  event_id              INT UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  subtitle              TEXT,
  description           TEXT,
  start_date            DATE,
  end_date              DATE,
  timezone              VARCHAR DEFAULT 'Europe/Moscow',
  status                TEXT DEFAULT 'draft',
  require_speakers_sub  BOOLEAN DEFAULT FALSE,
  vip_upsell_url        TEXT,
  landing_url           TEXT,
  getcourse_form_url    TEXT,
  chat_url              TEXT,
  stream_url_day_1      TEXT,
  stream_url_day_2      TEXT,
  is_live               BOOLEAN DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conf_speakers (
  id            SERIAL PRIMARY KEY,
  event_id      INT REFERENCES events(id) ON DELETE CASCADE,
  slug          TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL,  -- organizer|headliner|commercial|speaker|partner|general_partner
  name          VARCHAR NOT NULL,
  title         VARCHAR,
  company       VARCHAR,
  bio           TEXT,
  achievements  TEXT,
  photo_url     TEXT,
  poster_url    TEXT,
  telegram_url  TEXT,
  instagram_url TEXT,
  website_url   TEXT,
  partner_url   TEXT,
  is_visible    BOOLEAN DEFAULT TRUE,
  sort_order    INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conf_sessions (
  id               SERIAL PRIMARY KEY,
  event_id         INT REFERENCES events(id) ON DELETE CASCADE,
  speaker_id       INT REFERENCES conf_speakers(id),
  day              INT NOT NULL,
  start_datetime   TIMESTAMPTZ,
  title            VARCHAR NOT NULL,
  gift_description TEXT,
  track_label      VARCHAR,
  track_color      VARCHAR,
  sort_order       INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conf_broadcast_messages (
  id               SERIAL PRIMARY KEY,
  event_id         INT REFERENCES events(id) ON DELETE CASCADE,
  session_id       INT REFERENCES conf_sessions(id),
  speaker_id       INT REFERENCES conf_speakers(id),
  type             TEXT NOT NULL,  -- pre_5min|pre_30min|pre_1day|post_thanks|day_start|speaker_intro|manual
  scheduled_at     TIMESTAMPTZ,
  text             TEXT,
  status           TEXT DEFAULT 'draft',  -- draft|scheduled|sent|cancelled
  is_edited        BOOLEAN DEFAULT FALSE,
  needs_review     BOOLEAN DEFAULT FALSE,
  sent_at          TIMESTAMPTZ,
  recipients_count INT
);

CREATE TABLE IF NOT EXISTS conf_commercial_items (
  id          SERIAL PRIMARY KEY,
  event_id    INT REFERENCES events(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,  -- 'service' | 'material'
  title       VARCHAR NOT NULL,
  description TEXT,
  is_paid     BOOLEAN DEFAULT FALSE,
  action_url  TEXT,
  sort_order  INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conf_secret_codes (
  id              SERIAL PRIMARY KEY,
  event_id        INT REFERENCES events(id) ON DELETE CASCADE,
  speaker_id      INT REFERENCES conf_speakers(id),
  code_word       VARCHAR NOT NULL,
  tickets_reward  INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conf_promo_partners (
  id            SERIAL PRIMARY KEY,
  event_id      INT REFERENCES events(id) ON DELETE CASCADE,
  name          VARCHAR NOT NULL,
  telegram_url  TEXT,
  partner_code  VARCHAR NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, partner_code)
);
