-- 340: починка плиток дашборда «Обработка заявок» (2026-09-02)
--
-- ⚠️ Ошибка предыдущей миграции 339. Плитки были заведены на варианты
-- «Да» и «Нет», но снятая галочка ответ УДАЛЯЕТ, а не пишет словом «Нет»
-- (иначе отметку нельзя было бы снять обратно). Поэтому плитка «Нет»
-- всегда показывала ноль, и главную цифру — «сколько заявок осталось
-- разобрать» — дашборд не показывал вовсе.
--
-- Правильно так:
--   «Обработано»    — плитка без варианта: сколько ответили на поле.
--   «Не обработано» — плитка с условием «поле не заполнено».
-- Считается это разными механизмами, поэтому и карточки разные.

-- Старые плитки «Да»/«Нет» убираем только у автосозданных дашбордов анкет:
-- если клиент успел собрать свои — их не трогаем.
DELETE FROM analytics_cards c
 USING analytics_dashboards d
 WHERE c.dashboard_id = d.id
   AND d.survey_id IS NOT NULL
   AND d.title = 'Обработка заявок'
   AND c.option_value IN ('Да', 'Нет');

-- «Обработано»: плитка без варианта = число ответивших на это поле.
INSERT INTO analytics_cards
    (dashboard_id, source, ref_id, survey_id, view, title, sort_order)
SELECT d.id, 'question', q.id, d.survey_id, 'tile', 'Обработано', 0
  FROM analytics_dashboards d
  JOIN survey_questions q
    ON q.survey_id = d.survey_id AND q.is_protected AND q.filled_by = 'staff'
 WHERE d.survey_id IS NOT NULL
   AND d.title = 'Обработка заявок'
   AND NOT EXISTS (
       SELECT 1 FROM analytics_cards c
        WHERE c.dashboard_id = d.id AND c.title = 'Обработано'
   );

-- «Не обработано»: то же поле, но с условием «не заполнено».
-- Разрез оставляем тот же — иначе в знаменателе процентов оказалась бы
-- другая аудитория, и две цифры на одном экране считались бы по-разному.
INSERT INTO analytics_cards
    (dashboard_id, source, ref_id, survey_id, view, title, sort_order, filters)
SELECT d.id, 'question', q.id, d.survey_id, 'tile', 'Не обработано', 10,
       jsonb_build_object(
           'op', 'and',
           'items', jsonb_build_array(jsonb_build_object(
               'source', 'question',
               'ref_id', q.id,
               'operator', 'empty',
               'values', '[]'::jsonb
           ))
       )
  FROM analytics_dashboards d
  JOIN survey_questions q
    ON q.survey_id = d.survey_id AND q.is_protected AND q.filled_by = 'staff'
 WHERE d.survey_id IS NOT NULL
   AND d.title = 'Обработка заявок'
   AND NOT EXISTS (
       SELECT 1 FROM analytics_cards c
        WHERE c.dashboard_id = d.id AND c.title = 'Не обработано'
   );
