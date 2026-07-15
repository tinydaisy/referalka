-- 219. Ручной подарок спикера в общей таблице подарков (event_collaborator_lead_magnets).
--
-- ЗАЧЕМ. Ручной подарок спикера («Подарок после эфира» → вкладка «Ввести
-- вручную») хранился как ДВА свободных текстовых поля в event_collaborators:
-- gift_after_speech_title и gift_after_speech_url. Клиент вписывал туда СПИСОК
-- (4 названия в одно поле, 4 ссылки в другое) — и в рассылке сначала шли все
-- названия, потом все ссылки, без связи «название ↔ ссылка».
--
-- Теперь ручные подарки живут СТРОКАМИ в той же таблице, что и ПЛЮСОН-подарки
-- (до 4, общий порядок sort_order). Рассылка gift собирает «Название\nссылка»
-- по каждой строке — как для ПЛЮСОН-магнитов.
--
-- Строка таблицы теперь — ОДИН из трёх видов:
--   • ПЛЮСОН-лид-магнит  (lead_magnet_id)
--   • ПЛЮСОН-пакет        (package_id)
--   • ручной подарок      (manual_title + manual_url — ОБА обязательны)

ALTER TABLE event_collaborator_lead_magnets
  ADD COLUMN IF NOT EXISTS manual_title TEXT,
  ADD COLUMN IF NOT EXISTS manual_url   TEXT;

-- Заменяем старый CHECK (ровно один из magnet/package) на «ровно один из трёх
-- видов». Ручной вид = обе колонки заполнены (и title, и url).
ALTER TABLE event_collaborator_lead_magnets
  DROP CONSTRAINT IF EXISTS eclm_one_target;

ALTER TABLE event_collaborator_lead_magnets
  ADD CONSTRAINT eclm_one_target CHECK (
    (lead_magnet_id IS NOT NULL)::int
    + (package_id     IS NOT NULL)::int
    + (manual_title IS NOT NULL AND manual_title <> ''
       AND manual_url IS NOT NULL AND manual_url <> '')::int
    = 1
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON event_collaborator_lead_magnets TO plusson;
