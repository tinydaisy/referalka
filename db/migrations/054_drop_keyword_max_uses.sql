-- 054_drop_keyword_max_uses.sql
-- Удаляем `max_uses` и `used_count` из event_raffle_keywords.
--
-- Логика розыгрыша их не использует: одно кодовое слово может ввести любое
-- число участников, каждый получает свой билет (один участник одно слово
-- максимум один раз — это контролируется на уровне event_raffle_tickets).
--
-- Применить: psql -d plusson -f db/migrations/054_drop_keyword_max_uses.sql

ALTER TABLE event_raffle_keywords
  DROP COLUMN IF EXISTS max_uses,
  DROP COLUMN IF EXISTS used_count;
