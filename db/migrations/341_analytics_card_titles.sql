-- 341: названия у плиток и колонок дашборда (2026-09-02)
--
-- ⚠️ Плитка подписывалась ГОЛЫМ вариантом ответа («Да», «Инвестор»), потому
-- что своего названия у неё не было. Пока поле на дашборде одно, это ещё
-- читается; как только полей несколько — колонки «Да» и «Да» становятся
-- неразличимы, и клиент не понимает, где консультация, а где продажа.
--
-- Теперь название пишется при создании («Консультация проведена — Да») и
-- правится карандашиком. Этой миграцией дозаполняем уже созданные.
--
-- Плитки БЕЗ варианта не трогаем: у них подпись и так по названию разреза.

UPDATE analytics_cards c
   SET title = q.title || ' — ' || c.option_value
  FROM survey_questions q
 WHERE c.source = 'question'
   AND q.id = c.ref_id
   AND c.title IS NULL
   AND COALESCE(c.option_value, '') <> '';

UPDATE analytics_cards c
   SET title = f.title || ' — ' || c.option_value
  FROM contact_fields f
 WHERE c.source = 'field'
   AND f.id = c.ref_id
   AND c.title IS NULL
   AND COALESCE(c.option_value, '') <> '';
