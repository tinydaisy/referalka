-- 490. Навигация по чату: старый пункт «cabinet» → ДВА пункта
--
-- 22.09.2026 пункт разделён по смыслу (решение владельца):
--   gifts   — «Подарки за регистрацию и активность» → /podarki{event_id} в боте
--   cabinet — «Кабинет, Программа, Спикеры»         → меню события в боте
--
-- Новый ВИД добавлен в редактор и в резолвер ссылок, но существующие шаблоны
-- сами не разделятся: у них в `nav_items` лежит один старый пункт `cabinet`
-- с меткой «🎁 Подарки за регистрацию и активность • Ваш кабинет участника •
-- Программа • Спикеры:». Правим данные — иначе владелец видит в чате всё тот
-- же единственный пункт (прод, событие 89).
--
-- ⚠️ Вставляем `gifts` ПЕРЕД `cabinet` и сохраняем порядок остальных пунктов:
-- подарки — то, ради чего человек в этот список чаще всего и идёт.
--
-- ⚠️ Трогаем ТОЛЬКО пункты, где метка похожа на старую склейку (упоминает
-- подарки). Пункт `cabinet`, который клиент уже переименовал во что-то своё,
-- не трогаем вовсе: разделить его надвое значило бы переписать чужой текст.
--
-- Идемпотентно: где `gifts` уже есть — пропускаем.

-- ── 1. Шаблоны рассылок ────────────────────────────────────────────────
UPDATE broadcast_templates t
   SET nav_items = (
       SELECT jsonb_agg(
                CASE
                  WHEN elem->>'kind' = 'cabinet' THEN
                    jsonb_build_array(
                      jsonb_build_object(
                        'kind',  'gifts',
                        'label', '🎁 Подарки за регистрацию и активность:'),
                      jsonb_build_object(
                        'kind',  'cabinet',
                        'label', 'Ваш кабинет участника • Программа • Спикеры:')
                    )
                  ELSE jsonb_build_array(elem)
                END
                ORDER BY ord)
         FROM jsonb_array_elements(t.nav_items) WITH ORDINALITY AS a(elem, ord)
   )
 WHERE t.type = 'chat_nav'
   AND t.nav_items IS NOT NULL
   AND jsonb_typeof(t.nav_items) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.nav_items) e
                WHERE e->>'kind' = 'cabinet' AND e->>'label' ILIKE '%подарки%')
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.nav_items) e
                    WHERE e->>'kind' = 'gifts');

-- ⚠️ jsonb_agg выше собрал МАССИВ МАССИВОВ (каждый пункт обёрнут в
-- jsonb_build_array, чтобы `cabinet` мог раскрыться в два). Разворачиваем в
-- плоский список — иначе резолвер получит вложенные массивы вместо словарей
-- и не покажет ни одного пункта.
UPDATE broadcast_templates t
   SET nav_items = (
       SELECT jsonb_agg(inner_elem ORDER BY ord, inner_ord)
         FROM jsonb_array_elements(t.nav_items) WITH ORDINALITY AS a(elem, ord),
              jsonb_array_elements(a.elem) WITH ORDINALITY AS b(inner_elem, inner_ord)
   )
 WHERE t.type = 'chat_nav'
   AND t.nav_items IS NOT NULL
   AND jsonb_typeof(t.nav_items) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.nav_items) e
                WHERE jsonb_typeof(e) = 'array');

-- ── 2. Библиотека дефолтных шаблонов ───────────────────────────────────
-- Чтобы события, которые возьмут шаблон ПОЗЖЕ, получили уже разделённые пункты.
UPDATE default_broadcast_templates d
   SET nav_items = (
       SELECT jsonb_agg(
                CASE
                  WHEN elem->>'kind' = 'cabinet' THEN
                    jsonb_build_array(
                      jsonb_build_object(
                        'kind',  'gifts',
                        'label', '🎁 Подарки за регистрацию и активность:'),
                      jsonb_build_object(
                        'kind',  'cabinet',
                        'label', 'Ваш кабинет участника • Программа • Спикеры:')
                    )
                  ELSE jsonb_build_array(elem)
                END
                ORDER BY ord)
         FROM jsonb_array_elements(d.nav_items) WITH ORDINALITY AS a(elem, ord)
   )
 WHERE d.type = 'chat_nav'
   AND d.nav_items IS NOT NULL
   AND jsonb_typeof(d.nav_items) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.nav_items) e
                WHERE e->>'kind' = 'cabinet')
   AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.nav_items) e
                    WHERE e->>'kind' = 'gifts');

UPDATE default_broadcast_templates d
   SET nav_items = (
       SELECT jsonb_agg(inner_elem ORDER BY ord, inner_ord)
         FROM jsonb_array_elements(d.nav_items) WITH ORDINALITY AS a(elem, ord),
              jsonb_array_elements(a.elem) WITH ORDINALITY AS b(inner_elem, inner_ord)
   )
 WHERE d.type = 'chat_nav'
   AND d.nav_items IS NOT NULL
   AND jsonb_typeof(d.nav_items) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.nav_items) e
                WHERE jsonb_typeof(e) = 'array');
