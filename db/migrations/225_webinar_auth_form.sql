-- 225. Вебинар: форма авторизации зрителя + идентификация по tg_id.
--
-- ЗАЧЕМ. Зритель из личной ссылки (бот/Mini App/письмо) уже опознан (contact_id/tg_id).
-- Но пришедший из РАССЫЛКИ В ЧАТ — обезличен (одна ссылка на всех). Чтобы не терять
-- таких людей, перед эфиром (нашим ИЛИ Zoom) показываем форму авторизации:
-- настраиваемые поля (email/телефон/ник TG) + реф-код (pid) + UTM → дедуп/создание
-- контакта. Данные формы запоминаются у зрителя (cookie), чтобы не вводить каждый раз.
--
-- Авто-авторизация: если в ссылке есть contact_id/tg_id — форму не показываем.

BEGIN;

ALTER TABLE webinar_rooms
  -- форма авторизации: off = не требовать; auto = только если не опознан по ссылке; always = всем
  ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'auto',
  -- какие поля формы обязательны (клиент настраивает)
  ADD COLUMN IF NOT EXISTS auth_require_name  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auth_require_email BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auth_require_phone BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auth_require_tg    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auth_intro_text    TEXT;

-- tg_id зрителя в presence/activity — для опознания из Mini App/бота даже без contact_id.
ALTER TABLE webinar_presence ADD COLUMN IF NOT EXISTS tg_id BIGINT;
ALTER TABLE webinar_activity ADD COLUMN IF NOT EXISTS tg_id BIGINT;

-- Флаг «был в эфире» + история присутствия на контакте (быстрый доступ из карточки).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS was_in_webinar BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_rooms, webinar_presence, webinar_activity, contacts TO plusson;

COMMIT;
