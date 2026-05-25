-- 112_event_announcement_texts.sql
-- 2026-05-25
--
-- Тексты-анонсы события — отдельная от event_referral_share_texts сущность.
-- Назначение: готовые тексты, которые СПИКЕР/ПАРТНЁР копирует и шлёт своей
-- аудитории, чтобы анонсировать событие. Аудитория и контекст отличаются от
-- шеринга реф-программы (там тексты «зови друзей за подарки» — для участника
-- события). Поэтому отдельная таблица и набор плейсхолдеров.
--
-- Плейсхолдеры подставляются в момент отображения на стороне фронта:
--   {link}  — личная реф-ссылка пользователя на событие (TG по умолчанию)
--   {event} — название события (events.title)
--   {date}  — отформатированная дата старта (DD.MM.YYYY HH:MM МСК)
--   {brand} — название бренда клиента (clients.brand_name || clients.name)

BEGIN;

CREATE TABLE IF NOT EXISTS event_announcement_texts (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  sort        INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_event_announcement_texts_event_id
  ON event_announcement_texts(event_id, sort);

COMMIT;
