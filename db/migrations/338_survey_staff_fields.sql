-- 338: поля сотрудника в анкете — обработка заявок (2026-09-02)
--
-- Зачем. Анкету заполняет посетитель, но дальше с заявкой РАБОТАЮТ: звонят,
-- отмечают «обработано», пишут заметку. Записывать это было некуда — все
-- вопросы анкеты видны посетителю и заполняются им.
--
-- Решение: у вопроса появляется признак, КТО его заполняет. Поле сотрудника —
-- это тот же вопрос анкеты (та же таблица, тот же ответ в survey_answers),
-- просто посетителю он не показывается и не отправляется.
--
-- ⚠️ Почему ответ сотрудника лежит в survey_answers, а НЕ в contact_field_values.
-- Поле контакта — одно значение на человека: заполнил две анкеты — значение
-- общее. Для «Обработано» это неверно: обрабатывают КАЖДУЮ заявку отдельно,
-- и человек с двумя заявками должен иметь две независимые отметки. Поэтому
-- поля сотрудника живут ответом на конкретное заполнение и связи с
-- contact_fields не имеют (field_id у них всегда NULL).

-- ── Кто заполняет вопрос ──────────────────────────────────────────────────
-- 'visitor' — посетитель, обычный вопрос анкеты (всё, что было до сих пор).
-- 'staff'   — основатель и его сотрудники при обработке заявки.
ALTER TABLE survey_questions
    ADD COLUMN IF NOT EXISTS filled_by TEXT NOT NULL DEFAULT 'visitor';

DO $$
BEGIN
    ALTER TABLE survey_questions
        ADD CONSTRAINT survey_questions_filled_by_chk
        CHECK (filled_by IN ('visitor', 'staff'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN survey_questions.filled_by IS
  'Кто заполняет: visitor — посетитель в анкете, staff — сотрудник при обработке заявки.';

-- ── Защита от удаления ────────────────────────────────────────────────────
-- «Обработано» — опора всего разбора заявок: по ней красится строка в таблице,
-- по ней строится дашборд анкеты. Удалить её клиент не может (решение
-- владельца). Флагом, а не хардкодом по названию: название клиент вправе
-- переписать под себя, и после переименования защита не должна отваливаться.
ALTER TABLE survey_questions
    ADD COLUMN IF NOT EXISTS is_protected BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN survey_questions.is_protected IS
  'Системное поле: удалять нельзя (переименовать можно). Сейчас — «Обработано».';

-- Быстрый отбор полей сотрудника при отрисовке таблицы ответов.
CREATE INDEX IF NOT EXISTS idx_survey_questions_staff
    ON survey_questions(survey_id, sort_order, id)
 WHERE filled_by = 'staff';

-- ── Два поля в КАЖДУЮ анкету, включая уже существующие ────────────────────
-- ⚠️ Бэкфилл обязателен: на проде 7 живых анкет и полторы сотни заполнений.
-- Без него у накопленных заявок не было бы чем отмечать обработку, и раздел
-- открылся бы пустым ровно там, где он нужнее всего.
--
-- sort_order с большим запасом (10000+), чтобы поля сотрудника шли ПОСЛЕ
-- вопросов посетителя и не перемешивались с ними при перетаскивании.
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

-- ── Настройка отображения таблицы ответов ─────────────────────────────────
-- Какие колонки показывать и как сортировать — на АНКЕТЕ, а не на человеке:
-- настройку делает владелец под свой процесс, и помощники должны видеть
-- ту же таблицу, что и он, иначе они разойдутся в том, что обсуждают.
--
-- Формат columns: {"visible": ["created_at","name","email","q:12"], "sort": {...}}
-- Пусто = показать разумный минимум (дата, имя, почта, телефон, поля
-- сотрудника). Вопросы посетителя по умолчанию скрыты: в анкете их бывает
-- под тридцать, и таблица на тридцать колонок нечитаема.
ALTER TABLE surveys
    ADD COLUMN IF NOT EXISTS table_settings JSONB NOT NULL DEFAULT '{}'::JSONB;

COMMENT ON COLUMN surveys.table_settings IS
  'Настройка таблицы ответов: какие колонки видны и порядок сортировки. Общая на анкету.';
