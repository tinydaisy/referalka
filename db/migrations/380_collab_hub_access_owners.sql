-- 380. Доступ к материалам Коллабораторной клиентам 1 и 3 — бессрочно.
--
-- ⚠️⚠️ УСТАРЕЛА В ДЕНЬ НАКАТА. Материалы переехали в кабинет ПЛЮСОНа
-- (module_materials.py), и доступ решается ФИЧЕЙ модуля, а не строкой в
-- product_access. Выданные ею доступы безвредны и никому не мешают, но новых
-- так выдавать не надо — и повторять этот приём для следующего модуля тоже.
-- Файл оставлен как есть: миграция уже накачена, удаление файла разошлось бы с
-- учётом в schema_migrations.
--
-- Зачем руками, а не механизмом выдачи: механизм срабатывает при ОПЛАТЕ модуля,
-- а владельцу платформы и системному кабинету покупать его незачем — они и так
-- на тарифе admin, где модуль есть по фиче. Без этой строки они не смогли бы
-- открыть собственные уроки, чтобы их проверить.
--
-- ⚠️ Доступ висит на КОНТАКТЕ, а не на клиенте: `product_access.contact_id`.
--    Поэтому клиента заводим контактом в базе владельца уроков (системного) по
--    его почте — то же самое делает `grant_module_product_access` при покупке.
--
-- ⚠️ `expires_at = NULL` = БЕССРОЧНО (миграция 369). Это осознанно: у покупателя
--    доступ живёт, пока активен модуль, а у владельца площадки срока нет —
--    иначе он однажды потеряет доступ к своим же материалам.
--
-- ⚠️ Идемпотентно: `ON CONFLICT (product_id, contact_id)`. Повторный прогон
--    ничего не задваивает и не сбрасывает `revoked_at` тем, кому доступ
--    закрывали осознанно... — наоборот, СБРАСЫВАЕТ: это выдача, и если доступ
--    закрывали, повторный прогон миграции его вернёт. На этих двух кабинетах
--    закрывать его некому.

DO $$
DECLARE
    v_owner    INTEGER;   -- владелец уроков (системный клиент)
    v_product  INTEGER;
    v_client   INTEGER;
    v_email    TEXT;
    v_name     TEXT;
    v_phone    TEXT;
    v_contact  INTEGER;
    v_access   INTEGER;
    v_code     TEXT;
BEGIN
    SELECT p.id, p.client_id INTO v_product, v_owner
      FROM products p JOIN clients c ON c.id = p.client_id
     WHERE c.is_system_service = TRUE AND p.slug = 'collab-hub'
     LIMIT 1;
    IF v_product IS NULL THEN
        RAISE NOTICE 'Продукта collab-hub нет — сначала миграции 375 и 379';
        RETURN;
    END IF;

    -- Клиент 1 (владелец платформы) и системный. Берём по флагу и по id=1:
    -- у клиента 1 отличительного признака в схеме нет.
    FOR v_client, v_email, v_name, v_phone IN
        SELECT id, LOWER(TRIM(email)), name, phone
          FROM clients
         WHERE (id = 1 OR is_system_service = TRUE)
           AND COALESCE(TRIM(email), '') <> ''
    LOOP
        -- Контакт в базе владельца уроков. Ищем по email-ИДЕНТИЧНОСТИ:
        -- колонки contacts.email не существует (дропнута миграцией 282).
        v_contact := NULL;
        SELECT c.id INTO v_contact
          FROM contacts c
          JOIN platform_users pu ON pu.contact_id = c.id
               AND pu.platform_slug = 'email' AND pu.platform_user_id = v_email
         WHERE c.client_id = v_owner AND c.merged_into IS NULL
         LIMIT 1;

        IF v_contact IS NULL THEN
            -- ⚠️ ref_code NOT NULL с миграции 060 — без него INSERT падает.
            --    Формат тот же, что у generate_ref_code: 8 символов из
            --    ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (без 0/O/1/I — их путают).
            LOOP
                v_code := (
                    SELECT string_agg(
                        substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                               1 + floor(random() * 32)::int, 1), '')
                      FROM generate_series(1, 8));
                EXIT WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE ref_code = v_code);
            END LOOP;

            INSERT INTO contacts (client_id, name, phone, ref_code)
            VALUES (v_owner, v_name, v_phone, v_code)
            RETURNING id INTO v_contact;

            -- ⚠️ Колонки platform_users.client_id НЕТ — дропнута миграцией 327.
            --    Клиент берётся через контакт: contacts.client_id.
            INSERT INTO platform_users
                   (contact_id, platform_slug, platform_user_id)
            VALUES (v_contact, 'email', v_email)
            ON CONFLICT (contact_id, platform_slug) DO NOTHING;
        END IF;

        INSERT INTO product_access (product_id, contact_id, source, expires_at)
        VALUES (v_product, v_contact, 'manual', NULL)
        ON CONFLICT (product_id, contact_id)
        DO UPDATE SET expires_at = NULL, revoked_at = NULL, expiry_warned_at = NULL
        RETURNING id INTO v_access;

        IF v_access IS NOT NULL THEN
            INSERT INTO product_access_events (access_id, kind, detail, actor)
            VALUES (v_access, 'granted', 'владелец площадки, бессрочно', 'system');
        END IF;

        RAISE NOTICE 'Доступ к урокам: клиент % (%) → контакт %',
                     v_client, v_email, v_contact;
    END LOOP;
END $$;
