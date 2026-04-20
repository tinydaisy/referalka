-- ═══════════════════════════════════════════
-- Миграция 011: platform_users
-- Заменяет telegram_users на универсальную таблицу участников
-- Добавляет broadcast_templates и broadcast_schedules
-- ═══════════════════════════════════════════

-- ─────────────────────────────────────────
-- 1. ГЛОБАЛЬНЫЙ РЕЕСТР УЧАСТНИКОВ (per-client, per-platform)
-- ─────────────────────────────────────────
-- Уникальность: один человек у одного клиента на одной платформе = одна запись.
-- Тот же человек у другого клиента PLUSSON = другая запись (другой salebot_id).
CREATE TABLE IF NOT EXISTS platform_users (
  id                  SERIAL PRIMARY KEY,           -- внутренний pluson_id
  client_id           INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL DEFAULT 'telegram',  -- 'telegram' | 'max' | ...
  platform_user_id    TEXT NOT NULL,               -- tg_id / max_id (строка, универсально)
  username            TEXT,                         -- @ник / логин
  first_name          TEXT,
  last_name           TEXT,
  salebot_id          TEXT,                         -- ID пользователя в Salebot у этого клиента
  platform_meta       JSONB,                        -- специфичные поля платформы (если нужно)
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, platform, platform_user_id)
);

CREATE INDEX idx_platform_users_client ON platform_users(client_id);
CREATE INDEX idx_platform_users_platform_uid ON platform_users(platform, platform_user_id);
CREATE INDEX idx_platform_users_salebot ON platform_users(salebot_id) WHERE salebot_id IS NOT NULL;

-- ─────────────────────────────────────────
-- 2. УЧАСТИЕ В СОБЫТИИ (переработанное)
-- ─────────────────────────────────────────
-- Старая таблица event_participants остаётся (она пустая),
-- но меняем структуру: убираем tg_user_id, добавляем platform_user_id → platform_users.id
-- ref_code — уникален глобально (для поиска без фильтра по событию)

ALTER TABLE event_participants
  DROP COLUMN IF EXISTS tg_user_id,
  DROP COLUMN IF EXISTS ref_code_paid,
  DROP COLUMN IF EXISTS points_total,
  ADD COLUMN platform_user_id INT REFERENCES platform_users(id) ON DELETE CASCADE,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'interested';
  -- статусы: 'interested' | 'registered' | 'in_chat'

-- Уникальность: один участник в одном событии
ALTER TABLE event_participants
  DROP CONSTRAINT IF EXISTS event_participants_event_id_tg_user_id_key;

ALTER TABLE event_participants
  ADD CONSTRAINT event_participants_event_platform_user_key
  UNIQUE(event_id, platform_user_id);

CREATE INDEX idx_event_participants_platform_user ON event_participants(platform_user_id);
CREATE INDEX idx_event_participants_status ON event_participants(event_id, status);

-- ─────────────────────────────────────────
-- 3. ШАБЛОНЫ РАССЫЛОК
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_templates (
  id          SERIAL PRIMARY KEY,
  client_id   INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  event_id    INT REFERENCES events(id) ON DELETE CASCADE,  -- NULL = шаблон для всех событий клиента
  name        TEXT NOT NULL,        -- название для удобства в интерфейсе
  type        TEXT NOT NULL,        -- 'pre_start' | 'gift' | 'manual'
  text        TEXT,                 -- текст сообщения (поддерживает {speaker_name}, {session_title}, {gift})
  photo_url   TEXT,                 -- URL фото (если есть)
  button_text TEXT,                 -- текст кнопки (если есть)
  button_url  TEXT,                 -- ссылка кнопки (если есть)
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_broadcast_templates_client ON broadcast_templates(client_id);
CREATE INDEX idx_broadcast_templates_event ON broadcast_templates(event_id);

-- ─────────────────────────────────────────
-- 4. РАСПИСАНИЕ РАССЫЛОК
-- ─────────────────────────────────────────
-- Список получателей и структура сообщения собираются в момент запуска,
-- не в момент создания записи.
CREATE TABLE IF NOT EXISTS broadcast_schedules (
  id              SERIAL PRIMARY KEY,
  event_id        INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id      INT REFERENCES conf_sessions(id) ON DELETE CASCADE,  -- NULL = не привязана к сессии
  template_id     INT REFERENCES broadcast_templates(id) ON DELETE SET NULL,
  type            TEXT NOT NULL,        -- 'pre_start' | 'gift' | 'manual'
  fire_at         TIMESTAMPTZ NOT NULL, -- когда запустить
  status          TEXT NOT NULL DEFAULT 'pending',
  -- статусы: 'pending' | 'running' | 'done' | 'cancelled'
  is_test         BOOLEAN DEFAULT FALSE,       -- если true — слать только на test_recipients
  test_recipients JSONB,                       -- [{"platform": "telegram", "platform_user_id": "123"}]
  recipients_sent INT DEFAULT 0,
  error_log       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE INDEX idx_broadcast_schedules_event ON broadcast_schedules(event_id);
CREATE INDEX idx_broadcast_schedules_fire ON broadcast_schedules(fire_at, status);  -- для Celery-поллинга

-- ─────────────────────────────────────────
-- 5. ЛОГ ОТПРАВОК (каждое сообщение — строка)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcast_log (
  id              SERIAL PRIMARY KEY,
  schedule_id     INT NOT NULL REFERENCES broadcast_schedules(id) ON DELETE CASCADE,
  platform_user_id INT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'sent' | 'failed' | 'skipped'
  error           TEXT,
  sent_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_broadcast_log_schedule ON broadcast_log(schedule_id);
