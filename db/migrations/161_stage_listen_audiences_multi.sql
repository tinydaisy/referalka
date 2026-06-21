-- 161: Множественный выбор «Кого слушаем в каждом этапе»
-- Было: conf_stages.listen_audience TEXT (одно значение: viewers|speakers)
-- Стало: conf_stages.listen_audiences TEXT[] — несколько ролей одновременно.
--   Значения: 'participants' (зарег. участники, ep), 'speakers' (спикеры/хедлайнеры, ec),
--             'jury' (жюри, ec role=jury).
--   Пустой массив {} = «не слушать» этап.
-- Старое поле listen_audience оставляем (не дропаем) для безопасного отката.

ALTER TABLE conf_stages ADD COLUMN IF NOT EXISTS listen_audiences TEXT[] NOT NULL DEFAULT '{participants}';

-- Бэкфилл из старого одиночного поля.
UPDATE conf_stages
   SET listen_audiences = CASE
       WHEN listen_audience = 'speakers' THEN ARRAY['speakers']::text[]
       ELSE ARRAY['participants']::text[]
   END;

GRANT SELECT, INSERT, UPDATE, DELETE ON conf_stages TO plusson;
