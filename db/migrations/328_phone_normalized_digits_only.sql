-- 328: phone_normalized — ТОЛЬКО ЦИФРЫ, без плюса
--
-- ЗАЧЕМ. Нормализованный телефон — не то, что показывают человеку, а ключ
-- поиска дублей. Плюс к самому номеру отношения не имеет и лишь плодил разные
-- написания одного и того же: `+79161234567` и `79161234567` для базы были
-- разными строками, и один человек заводился дважды.
--
-- Как лежало до миграции (3766 контактов с телефоном):
--   3288  +7XXXXXXXXXX  российский с плюсом
--    373  без плюса, прочее
--     62  с плюсом, прочее
--     43  7XXXXXXXXXX   российский БЕЗ плюса
-- То есть один и тот же российский номер хранился в двух видах.
--
-- ⚠️ Колонка `contacts.phone` НЕ трогается — человек видит телефон в том виде,
-- как ввёл. Меняется только служебное поле поиска.
--
-- Правило (совпадает с normalize_phone в services/contact_merge.py):
--   • только цифры;
--   • ведущие нули набора («+007…», «+0037…») срезаются;
--   • 11 цифр с 8 → 7XXXXXXXXXX;
--   • 10 цифр с 9 → 7XXXXXXXXXX (российский без кода страны);
--   • остальное — как есть, цифрами.
--
-- ⚠️ Дубли НЕ сливаются: миграция только выравнивает формат. После неё
-- одинаковые номера станут одинаковыми строками, и автопоиск дублей начнёт
-- их видеть — решение о слиянии остаётся за клиентом.

WITH src AS (
    SELECT id,
           regexp_replace(COALESCE(NULLIF(phone_normalized, ''), phone), '[^0-9]', '', 'g') AS d
      FROM contacts
     WHERE COALESCE(NULLIF(phone_normalized, ''), NULLIF(phone, '')) IS NOT NULL
), stripped AS (
    -- Ведущие нули убираем, но не превращаем номер в пустоту.
    SELECT id, COALESCE(NULLIF(ltrim(d, '0'), ''), d) AS d FROM src
), norm AS (
    SELECT id,
           CASE
             WHEN length(d) = 11 AND left(d, 1) = '8' THEN '7' || right(d, 10)
             WHEN length(d) = 11 AND left(d, 1) = '7' THEN d
             WHEN length(d) = 10 AND left(d, 1) = '9' THEN '7' || d
             ELSE d
           END AS n
      FROM stripped
)
UPDATE contacts c
   SET phone_normalized = NULLIF(norm.n, ''),
       updated_at = NOW()
  FROM norm
 WHERE norm.id = c.id
   AND c.phone_normalized IS DISTINCT FROM NULLIF(norm.n, '');
