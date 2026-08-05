-- 265: Фильтр рассылок ПО ТЕГАМ контактов (включить / исключить)
--
-- Зачем. Аудитория рассылки задавалась только грубыми режимами
-- (all_client / registered_event / paid_event...). Сегменты вида
-- «клиенты ПЛЮСОНа без подписки», «без бота», «уже в Коллабораторной»
-- этими режимами не выражаются, а теги (contacts.tags) в базе уже есть
-- и активно используются (4000+ размеченных контактов у клиента 1).
--
-- Решение: два массива тегов на рассылку и на шаблон.
--   audience_tags_include — взять ТОЛЬКО тех, у кого есть ХОТЯ БЫ ОДИН из тегов
--                           (семантика ?| — «любой из», как в фильтре контактов);
--   audience_tags_exclude — выбросить тех, у кого есть ХОТЯ БЫ ОДИН из тегов.
-- NULL / пустой массив = фильтр не применяется (полная обратная совместимость:
-- все существующие рассылки продолжают работать как работали).
--
-- Исключение применяется ПОСЛЕ включения — если тег попал в оба списка,
-- человек НЕ получит рассылку (исключение сильнее, это безопасное поведение).

ALTER TABLE broadcast_schedules
  ADD COLUMN IF NOT EXISTS audience_tags_include TEXT[],
  ADD COLUMN IF NOT EXISTS audience_tags_exclude TEXT[];

ALTER TABLE broadcast_templates
  ADD COLUMN IF NOT EXISTS audience_tags_include TEXT[],
  ADD COLUMN IF NOT EXISTS audience_tags_exclude TEXT[];

-- Ускоряет поиск контактов по тегам (оператор ?| по jsonb-массиву).
CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin
  ON contacts USING GIN (tags jsonb_path_ops);
