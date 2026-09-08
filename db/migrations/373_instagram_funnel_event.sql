-- Воронка Instagram может вести на СОБЫТИЕ.
--
-- ⚠️ Четвёртый вариант выдачи рядом с лид-магнитом, пакетом и продуктом
-- (миграция 372). Комментарий под рилсом — тёплый интерес, и вести его
-- логично в том числе на регистрацию: вебинар, конференция, эфир.
--
-- ⚠️⚠️ СОБЫТИЕ ВЫДАЁТСЯ ССЫЛКОЙ, как и продукт: материалов, которые можно
-- прислать в директ, у него нет — человек идёт на страницу и регистрируется.
--
-- ⚠️ `ON DELETE CASCADE` как у остальных: воронка без того, на что она ведёт,
-- висела бы молча неработающей.
ALTER TABLE instagram_funnels
  ADD COLUMN IF NOT EXISTS event_id INT REFERENCES events(id) ON DELETE CASCADE;

-- ⚠️ Ограничение снова переписываем целиком: оно перечисляет ВСЕ варианты, и
-- с новой колонкой старое запрещало бы событие вовсе.
ALTER TABLE instagram_funnels DROP CONSTRAINT IF EXISTS ig_funnel_one_target;
ALTER TABLE instagram_funnels ADD CONSTRAINT ig_funnel_one_target CHECK (
  (lead_magnet_id IS NOT NULL)::int
+ (package_id     IS NOT NULL)::int
+ (product_id     IS NOT NULL)::int
+ (event_id       IS NOT NULL)::int = 1
);
