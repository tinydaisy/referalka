-- Миграция 059: тексты-примеры для шеринга в реф-программе (множественные)
--
-- ЧТО ДЕЛАЕМ:
--   1. Новая таблица event_referral_share_texts — список текстов для шеринга
--      (раньше был один в event_referral_settings.share_text).
--   2. Переносим существующий share_text в первую запись новой таблицы.
--   3. Удаляем колонки welcome_text и share_text из event_referral_settings —
--      welcome_text не используется нигде, share_text заменён списком.
--
-- ВКЛАДКА «Шаблоны» в дашборде удаляется. Тексты-примеры теперь в Материалах.
-- gift_count_mode и is_enabled остаются в event_referral_settings.

BEGIN;

CREATE TABLE IF NOT EXISTS event_referral_share_texts (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_share_texts_event
    ON event_referral_share_texts(event_id, sort, id);

-- Переносим существующий share_text в новую таблицу
INSERT INTO event_referral_share_texts (event_id, content, sort)
SELECT event_id, share_text, 0
  FROM event_referral_settings
 WHERE share_text IS NOT NULL
   AND length(trim(share_text)) > 0;

-- Удаляем устаревшие колонки
ALTER TABLE event_referral_settings DROP COLUMN IF EXISTS welcome_text;
ALTER TABLE event_referral_settings DROP COLUMN IF EXISTS share_text;

COMMIT;
