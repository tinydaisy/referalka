-- 494: индексы для сопоставления контакта с аккаунтом ПЛЮСОНа.
--
-- Блок CRM «ПЛЮСОН: кто из них дошёл до платформы» ищет человека по почте,
-- никам площадок и телефону (`services/plusson_match.py`), потому что поле
-- `contacts.linked_client_id` на практике не заполняется ни у кого.
--
-- ⚠️ Существующие индексы `platform_users` построены по СЫРЫМ полям, а
-- сравнение идёт через LOWER() — планировщик их не берёт и уходит в полный
-- перебор: 3 секунды на событие из 264 человек. Нужны функциональные индексы
-- ровно того вида, в каком написано сравнение.

-- Ник/идентификатор площадки в нижнем регистре — по нему ищутся и клиенты,
-- и «карточки-двойники» человека в базах разных клиентов.
CREATE INDEX IF NOT EXISTS idx_platform_users_plat_lower_username
    ON platform_users (platform_slug, LOWER(COALESCE(username, platform_user_id)));

-- Отдельно по `platform_user_id`: у почты ника нет вовсе, и адрес лежит
-- именно здесь, а у людей без @username это единственный признак.
CREATE INDEX IF NOT EXISTS idx_platform_users_plat_lower_uid
    ON platform_users (platform_slug, LOWER(TRIM(platform_user_id)));

-- Телефон контакта по последним 10 цифрам: `+79212861071` и `89212861071` —
-- один и тот же человек, и сравнивать их надо в одном виде.
CREATE INDEX IF NOT EXISTS idx_contacts_phone_digits10
    ON contacts (RIGHT(regexp_replace(phone, '\D', '', 'g'), 10))
 WHERE phone IS NOT NULL;

-- Реф-код захода в @pluson_bot: строк с ним мало (48 из 5330), поэтому
-- частичный индекс — он в разы меньше полного и попадает в память целиком.
CREATE INDEX IF NOT EXISTS idx_contacts_plusson_referrer_code
    ON contacts (plusson_referrer_code)
 WHERE plusson_referrer_code IS NOT NULL;
