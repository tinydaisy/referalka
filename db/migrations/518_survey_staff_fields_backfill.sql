-- 518: «Обработано» + «Заметка» в анкетах, созданных после миграции 338
--
-- ⚠️ Зачем. Миграция 338 добавила поля сотрудника только анкетам, что были на
-- тот момент, а создание анкеты в кабинете (`create_survey`) их не заводило —
-- у новых анкет заявки было нечем отмечать «Обработано». Найдено 26.09.2026:
-- анкеты 17, 24, 27, 34. Код создания исправлен в той же правке; здесь —
-- догоняем уже созданные. Повторный прогон ничего не меняет (NOT EXISTS).

INSERT INTO survey_questions (survey_id, title, kind, filled_by, is_protected, sort_order)
SELECT s.id, 'Обработано', 'bool', 'staff', TRUE, 10000
  FROM surveys s
 WHERE NOT EXISTS (
     SELECT 1 FROM survey_questions q
      WHERE q.survey_id = s.id AND q.filled_by = 'staff' AND q.is_protected
 );

INSERT INTO survey_questions (survey_id, title, kind, filled_by, is_protected, sort_order)
SELECT s.id, 'Заметка', 'textarea', 'staff', FALSE, 10010
  FROM surveys s
 WHERE NOT EXISTS (
     SELECT 1 FROM survey_questions q
      WHERE q.survey_id = s.id AND q.filled_by = 'staff'
        AND q.kind = 'textarea' AND q.title = 'Заметка'
 );
