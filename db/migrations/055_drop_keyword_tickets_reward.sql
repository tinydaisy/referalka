-- 055_drop_keyword_tickets_reward.sql
-- Удаляем `tickets_reward` из event_raffle_keywords.
--
-- По новой модели: одно кодовое слово = ровно один билет участнику.
-- Никакой настройки «+N билетов за слово». Стартовый билет (за подписку)
-- технически тоже считается билетом со «словом» 'Free'.
-- Итого: число билетов участника = число введённых им слов (плюс Free,
-- если выполнил подписку).
--
-- Применить: psql -d plusson -f db/migrations/055_drop_keyword_tickets_reward.sql

ALTER TABLE event_raffle_keywords
  DROP COLUMN IF EXISTS tickets_reward;
