-- 282: дроп contacts.email / contacts.email_normalized
--
-- Почта человека живёт как ИДЕНТИЧНОСТЬ в platform_users(platform_slug='email'),
-- а не полем контакта. Так уже устроен резолв контакта (contact_merge.py:116),
-- дедуп по email и рассылки (tasks/broadcast.py берут адрес из platform_users).
--
-- Колонки остались хвостом от миграции 036 и были источником дублей: код,
-- искавший человека по contacts.email, не видел тех, у кого почта лежит только
-- в идентичности, и заводил вторую карточку.
--
-- ВНИМАНИЕ: перед накатом почты, которые были ТОЛЬКО в contacts.email,
-- перенесены в platform_users (52 контакта). Оставшиеся расхождения —
-- старые дубли контактов, где почта уже принадлежит второму контакту
-- того же человека; данные при дропе не теряются.

BEGIN;

-- страховка: если вдруг остался email без идентичности и почта СВОБОДНА — перенести
INSERT INTO platform_users (client_id, contact_id, platform_slug, platform_user_id, username)
SELECT c.client_id, c.id, 'email', lower(trim(c.email)), NULL
  FROM contacts c
 WHERE coalesce(trim(c.email), '') <> ''
   AND position('@' in c.email) > 1
   AND NOT EXISTS (SELECT 1 FROM platform_users pu
                    WHERE pu.contact_id = c.id AND pu.platform_slug = 'email')
   AND NOT EXISTS (SELECT 1 FROM platform_users p2
                    WHERE p2.client_id = c.client_id AND p2.platform_slug = 'email'
                      AND p2.platform_user_id = lower(trim(c.email)))
ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS idx_contacts_email_norm;

ALTER TABLE contacts DROP COLUMN IF EXISTS email_normalized;
ALTER TABLE contacts DROP COLUMN IF EXISTS email;

COMMIT;
