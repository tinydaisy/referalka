-- 298: Медийные активы — ЧИСЛО ЛЮДЕЙ вместо тысяч.
--
-- Было: поле подписчиков вводилось в ТЫСЯЧАХ («1.8» = 1800), а позиции,
-- которые считает система (базы и каналы ПЛЮСОНа), — в штуках. В одном списке
-- уживались две разные единицы: человек не понимал, что вводить, а суммарный
-- охват выходил в тысячи раз меньше правды — у клиента с каналом на 1800
-- подписчиков в каталоге стояло «до 1 000».
--
-- Стало: везде число людей.
--
-- ⚠️ Пересчитываем ТОЛЬКО дробные значения (0.53, 1.8, 3.04) — это записи в
-- тысячах. Целые (8000, 12000) уже введены людьми: их трогать нельзя, иначе
-- у половины участников охват вырос бы в тысячу раз.
UPDATE clients
   SET media_assets = (
       SELECT jsonb_agg(
                CASE
                  WHEN (a->>'subscribers') ~ '^[0-9]*\.[0-9]+$'
                    THEN jsonb_set(a, '{subscribers}',
                                   to_jsonb(round((a->>'subscribers')::numeric * 1000)::bigint))
                  ELSE a
                END
              )
         FROM jsonb_array_elements(media_assets) a
   )
 WHERE media_assets IS NOT NULL
   AND jsonb_typeof(media_assets) = 'array'
   AND media_assets::text ~ '[0-9]\.[0-9]';

-- «База» больше не выбирается: её считают автоматические позиции «в ПЛЮСОН».
-- Старые строки убираем — иначе они задваивали бы охват.
-- ⚠️ «Суммарно» ОСТАЁТСЯ: им пользуются, чтобы указать общий охват одной
-- строкой, не расписывая площадки.
UPDATE clients
   SET media_assets = COALESCE((
       SELECT jsonb_agg(a) FROM jsonb_array_elements(media_assets) a
        WHERE a->>'platform' <> 'database'
   ), '[]'::jsonb)
 WHERE media_assets IS NOT NULL
   AND jsonb_typeof(media_assets) = 'array'
   AND media_assets::text LIKE '%"database"%';

-- ⚠️ У позиций «в ПЛЮСОН» значение считает система — введённое руками
-- обнуляем. Иначе оно висит мусором: в форме показывается посчитанная цифра,
-- а в базе лежит другая, и в охват попадала бы неправильная. Так, у клиента 1
-- в «МАКС-боты в ПЛЮСОН» оказалось 1800 (подписчики его телеграм-канала).
UPDATE clients
   SET media_assets = COALESCE((
       SELECT jsonb_agg(
                CASE WHEN a->>'platform' LIKE 'plusson\_%'
                     THEN jsonb_set(a, '{subscribers}', '0'::jsonb)
                     ELSE a END)
         FROM jsonb_array_elements(media_assets) a
   ), '[]'::jsonb)
 WHERE media_assets IS NOT NULL
   AND jsonb_typeof(media_assets) = 'array'
   AND media_assets::text LIKE '%"plusson_%';
