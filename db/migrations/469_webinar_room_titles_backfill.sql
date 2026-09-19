-- 469: Заполнить пустые названия вебинарных комнат — «День N — Название события».
--
-- Зачем. Поле «Название вебинара (дня)» в кабинете показывало «День N» СЕРОЙ
-- ПОДСКАЗКОЙ (placeholder), то есть в базе оставалось пусто. Человек видел
-- заполненное на вид поле, но `webinar_rooms.title` был пустым — и в рассылках
-- плейсхолдер названия дня подставлялся пустой строкой. На проде пустых
-- названий оказалось большинство комнат.
--
-- ⚠️⚠️ N СЧИТАЕТСЯ ПО ДАТАМ (самая ранняя дата события = день 1), а НЕ по
-- `day_number`. `day_number` — это порядок ЗАВЕДЕНИЯ дня в программе: дни
-- добавляют не подряд, удаляют и вставляют между. Из-за него у эфира, первого
-- по календарю, в интерфейсе показывалось «День 4».
--
-- ⚠️ ТРОГАЕМ ТОЛЬКО ПУСТЫЕ. Названия, вписанные руками («Орг встреча»,
-- «День 1 - Соревновательные эфиры»), не перезаписываем: человек вписал их
-- осознанно, и подменять их выдумкой нельзя.
--
-- ⚠️ Дни БЕЗ даты идут в конец (NULLS LAST) — как и везде в проекте после
-- правки сортировки от 19.09.2026.

BEGIN;

WITH numbered AS (
    SELECT wr.id,
           e.title AS event_title,
           ROW_NUMBER() OVER (
               PARTITION BY wr.event_id
               ORDER BY cd.day_date NULLS LAST, wr.day_number
           ) AS day_index
      FROM webinar_rooms wr
      JOIN events e ON e.id = wr.event_id
      LEFT JOIN conf_days cd
             ON cd.event_id = wr.event_id AND cd.day_number = wr.day_number
     WHERE wr.title IS NULL OR btrim(wr.title) = ''
)
UPDATE webinar_rooms wr
   SET title = CASE
                 WHEN btrim(COALESCE(n.event_title, '')) <> ''
                   THEN 'День ' || n.day_index || ' — ' || n.event_title
                 ELSE 'День ' || n.day_index
               END,
       updated_at = NOW()
  FROM numbered n
 WHERE wr.id = n.id;

COMMIT;
