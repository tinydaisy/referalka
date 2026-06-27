-- Миграция 173: тип критерия «авто-число» — участник пишет кодовую фразу + число
-- в чате, число записывается в критерий. Два режима (auto_kind):
--   replace — последнее значение перезатирает предыдущее (напр. «деньги: 1000»)
--   sum     — значения суммируются (напр. «лид-магнит: 6», потом ещё «+4» = 10)
--
-- Парсинг: «слово:6», «слово: 6», «слово   6» — везде число 6 (двоеточие и
-- пробелы игнорируются). Логика — в app/services/chat_archive.py.

-- Расширяем CHECK по scorer: добавляем 'auto_number'
ALTER TABLE tournament_criteria DROP CONSTRAINT IF EXISTS tournament_criteria_scorer_check;
ALTER TABLE tournament_criteria ADD CONSTRAINT tournament_criteria_scorer_check
    CHECK (scorer = ANY (ARRAY['jury','vote','manual','auto','auto_number']::text[]));

-- Расширяем CHECK по auto_kind: добавляем 'replace' и 'sum' (режимы авто-числа)
ALTER TABLE tournament_criteria DROP CONSTRAINT IF EXISTS tournament_criteria_auto_kind_check;
ALTER TABLE tournament_criteria ADD CONSTRAINT tournament_criteria_auto_kind_check
    CHECK (auto_kind IS NULL OR auto_kind = ANY (ARRAY['referrals','lead_magnet','replace','sum']::text[]));
