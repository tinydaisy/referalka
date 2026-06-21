-- 161: Множественный выбор «Кого слушаем в каждом этапе»
-- Было: conf_stages.listen_audience TEXT (одно значение: viewers|speakers)
-- Стало: conf_stages.listen_audiences TEXT[] — несколько ролей одновременно.
--   Значения: 'all' (любой автор), 'registered' (только зарег. участники, ep),
--             'speakers' (спикеры/хедлайнеры, ec), 'jury' (жюри, ec role=jury).
--   Пустой массив {} = «не слушать» этап. 'all' хранится один, без других ролей.
-- Старое поле listen_audience оставляем (не дропаем) для безопасного отката.

ALTER TABLE conf_stages ADD COLUMN IF NOT EXISTS listen_audiences TEXT[] NOT NULL DEFAULT '{registered}';

-- Бэкфилл из старого одиночного поля.
UPDATE conf_stages
   SET listen_audiences = CASE
       WHEN listen_audience = 'speakers' THEN ARRAY['speakers']::text[]
       ELSE ARRAY['registered']::text[]
   END;

-- Совместимость, если миграция уже прогонялась со старым значением 'participants'.
UPDATE conf_stages
   SET listen_audiences = array_replace(listen_audiences, 'participants', 'registered')
 WHERE 'participants' = ANY(listen_audiences);

GRANT SELECT, INSERT, UPDATE, DELETE ON conf_stages TO plusson;
