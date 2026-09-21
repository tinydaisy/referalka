-- Миграция 483: правила чата в навигации — ССЫЛКА НА КАЖДУЮ ПЛОЩАДКУ.
--
-- Зачем. Правила нетворкинга — это ЗАКРЕПЛЁННЫЙ ПОСТ ВНУТРИ ЧАТА, а чат у
-- каждой площадки свой: у Telegram свой закреп, у ВКонтакте свой, у MAX свой.
-- Миграция 482 завела у пункта одно поле `url` на все площадки — человек из
-- ВК получил бы ссылку на телеграмный чат, где его нет (решение владельца
-- 21.09.2026).
--
-- Формат пункта правил: {"kind":"rules","label":"…",
--                        "urls":{"telegram":"…","vk":"…","max":"…"}}
-- Поле `url` у остальных видов (своя ссылка) остаётся как было.
--
-- ⚠️ Ссылка чужой площадки НЕ подставляется (в отличие от подарков и
-- регистрации, где это правильно): пункт просто не появляется там, где ссылка
-- не задана. Отправить человека в чат, куда он не входит, хуже, чем не
-- показать пункт.

-- Библиотека: у пункта правил вместо пустого `url` — пустой объект `urls`.
-- ⚠️ ON CONFLICT DO NOTHING в 482 уже отработал, менять тело INSERT бесполезно
-- (урок миграции 432) — правим UPDATE'ом.
UPDATE default_broadcast_templates
   SET nav_items = (
         SELECT jsonb_agg(
                  CASE WHEN item->>'kind' = 'rules'
                       THEN (item - 'url') || jsonb_build_object('urls', '{}'::jsonb)
                       ELSE item END
                  ORDER BY ord)
           FROM jsonb_array_elements(nav_items) WITH ORDINALITY AS t(item, ord)
       )
 WHERE type = 'chat_nav'
   AND nav_items IS NOT NULL
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(nav_items) e
                WHERE e->>'kind' = 'rules' AND e ? 'url');

-- То же для уже созданных шаблонов событий: клиент мог успеть добавить
-- шаблон до этой правки, и его пункт правил остался бы со старым полем.
-- Заполненный `url` переносим во ВСЕ площадки: клиент вписал одну ссылку —
-- пусть работает везде, пока он не задаст свои.
UPDATE broadcast_templates
   SET nav_items = (
         SELECT jsonb_agg(
                  CASE WHEN item->>'kind' = 'rules'
                       THEN (item - 'url') || jsonb_build_object('urls',
                              CASE WHEN COALESCE(btrim(item->>'url'), '') = ''
                                   THEN '{}'::jsonb
                                   ELSE jsonb_build_object(
                                          'telegram', item->>'url',
                                          'vk',       item->>'url',
                                          'max',      item->>'url')
                              END)
                       ELSE item END
                  ORDER BY ord)
           FROM jsonb_array_elements(nav_items) WITH ORDINALITY AS t(item, ord)
       )
 WHERE nav_items IS NOT NULL
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(nav_items) e
                WHERE e->>'kind' = 'rules' AND e ? 'url');

-- И в снимках рассылок, ещё не отправленных.
UPDATE broadcast_schedules
   SET nav_items = (
         SELECT jsonb_agg(
                  CASE WHEN item->>'kind' = 'rules'
                       THEN (item - 'url') || jsonb_build_object('urls',
                              CASE WHEN COALESCE(btrim(item->>'url'), '') = ''
                                   THEN '{}'::jsonb
                                   ELSE jsonb_build_object(
                                          'telegram', item->>'url',
                                          'vk',       item->>'url',
                                          'max',      item->>'url')
                              END)
                       ELSE item END
                  ORDER BY ord)
           FROM jsonb_array_elements(nav_items) WITH ORDINALITY AS t(item, ord)
       )
 WHERE nav_items IS NOT NULL
   AND status IN ('draft', 'pending')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(nav_items) e
                WHERE e->>'kind' = 'rules' AND e ? 'url');

COMMENT ON COLUMN broadcast_templates.nav_items IS
    'Пункты навигации для шаблона chat_nav: [{kind,label,url|urls,magnet_kind,magnet_id}]. У kind=rules ссылка своя на каждую площадку (urls). Пункт без ссылки не вставляется.';
