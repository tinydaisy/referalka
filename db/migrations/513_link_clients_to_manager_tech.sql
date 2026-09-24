-- 513: клиенты уходят тому внедренцу, за кем закреплён их контакт.
--
-- ⚠️⚠️ ЗАЧЕМ (решение владельца 24.09.2026). Один человек бывает и менеджером
-- лидов в кабинете, и внедренцем на платформе. Это были две НЕ связанные
-- привязки: контакт закреплён за менеджером, а кабинет ПЛЮСОНа того же
-- человека висел ничьим. Владельцу приходилось повторять ту же операцию
-- руками во вкладке «Клиенты» — двойная работа, о которой все забывают.
--
-- С этой миграции связь автоматическая (`api/contact_assignments.py`,
-- `propagate_to_tech`), а здесь — разовый подтяг УЖЕ существующих закреплений.
--
-- ⚠️ ЧУЖИХ НЕ ОТБИРАЕМ: `tech_specialist_id IS NULL` — если у клиента уже есть
-- внедренец, не трогаем. Это чужая работа и чужие деньги.
--
-- ⚠️ Менеджер и внедренец связываются ПО ПОЧТЕ: помощник живёт в `assistants`,
-- внедренец — роль над `clients`, прямой связи в базе нет.

WITH pairs AS (
    SELECT ca.contact_id, ts.id AS spec_id
      FROM contact_assignments ca
      JOIN assistant_grants g ON g.id = ca.grant_id
      JOIN assistants a ON a.id = g.assistant_id
      JOIN clients tc ON LOWER(TRIM(tc.email)) = LOWER(TRIM(a.email))
      JOIN tech_specialists ts ON ts.client_id = tc.id AND ts.is_active
)
UPDATE clients cl
   SET tech_specialist_id = p.spec_id,
       tech_assigned_at = COALESCE(cl.tech_assigned_at, NOW())
  FROM pairs p
 WHERE cl.tech_specialist_id IS NULL
   AND LOWER(TRIM(cl.email)) = LOWER(TRIM((
         SELECT pe.platform_user_id FROM platform_users pe
          WHERE pe.contact_id = p.contact_id
            AND pe.platform_slug = 'email'
          ORDER BY pe.id LIMIT 1)));
