-- Воронка Instagram может вести на ПРОДУКТ, а не только выдавать лид-магнит.
--
-- ⚠️ Зачем. Комментарий под рилсом — это тёплый интерес, и вести его логично
-- не только на бесплатный подарок, но и на платную страницу: мастер-класс,
-- клуб, наставничество. Раньше выбор был только между лид-магнитом и пакетом.
--
-- ⚠️⚠️ ПРОДУКТ ВЫДАЁТСЯ ССЫЛКОЙ НА СТРАНИЦУ, а не файлами. У лид-магнита есть
-- материалы, которые можно прислать в директ; у продукта материалы лежат за
-- оплатой, и слать их нельзя. Поэтому в директ уходит ссылка вида
-- {домен клиента}/pr/{slug} — дальше человек читает страницу и покупает.
--
-- ⚠️ `ON DELETE CASCADE` как у lead_magnet_id: воронка без того, что она
-- раздаёт, бессмысленна и висела бы молча неработающей.
ALTER TABLE instagram_funnels
  ADD COLUMN IF NOT EXISTS product_id INT REFERENCES products(id) ON DELETE CASCADE;

-- ⚠️⚠️ Старое ограничение требовало РОВНО ОДИН из двух (lead_magnet_id или
-- package_id) — с третьим вариантом оно запрещало бы продукт вовсе.
ALTER TABLE instagram_funnels DROP CONSTRAINT IF EXISTS ig_funnel_one_target;
ALTER TABLE instagram_funnels ADD CONSTRAINT ig_funnel_one_target CHECK (
  (lead_magnet_id IS NOT NULL)::int
+ (package_id     IS NOT NULL)::int
+ (product_id     IS NOT NULL)::int = 1
);
