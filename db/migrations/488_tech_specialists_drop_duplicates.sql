-- 488: дроп дублирующих полей внедренца — почта, пароль, имя, телефон, телеграм (2026-09-22)
--
-- Завершает переход, начатый 486: внедренец — роль клиента, личные данные живут
-- в `clients`. Пять колонок здесь были ВТОРОЙ копией того же человека, и это
-- ровно то, из-за чего у внедренца получалось два пароля и две почты.
--
-- ⚠️⚠️ ПОРЯДОК ВАЖЕН. Эта миграция идёт ПОСЛЕ того, как вход переведён на
-- клиентский пароль (эндпоинт `/api/v1/auth/tech/login` ищет внедренца через
-- клиента). Накати её раньше — и кабинет внедренца ляжет: прежний вход искал
-- именно `tech_specialists.email` + `password_hash`.
--
-- ⚠️ Третьего пароля в системе больше нет. Внедренец входит клиентским паролем
-- и меняет его в своём кабинете клиента — отдельная смена пароля внедренцем
-- не нужна и не делается.

-- Привязка обязательна: запись роли без клиента бессмысленна — в неё некому
-- войти (ни почты, ни пароля здесь уже нет).
-- ⚠️ Строк без client_id быть не должно: на момент перехода внедренцев в базе
-- ноль. Если появятся — NOT NULL упадёт громко, и это правильно: молча
-- оставленная строка-сирота стала бы записью, в которую нельзя войти.
ALTER TABLE tech_specialists ALTER COLUMN client_id SET NOT NULL;

-- Частичный индекс заменяем на честное ограничение: NULL теперь невозможен.
DROP INDEX IF EXISTS tech_specialists_client_uniq;
ALTER TABLE tech_specialists
    ADD CONSTRAINT tech_specialists_client_uniq UNIQUE (client_id);

ALTER TABLE tech_specialists
    DROP COLUMN IF EXISTS email,
    DROP COLUMN IF EXISTS password_hash,
    DROP COLUMN IF EXISTS name,
    DROP COLUMN IF EXISTS phone,
    DROP COLUMN IF EXISTS telegram_username;

COMMENT ON COLUMN tech_specialists.last_login_at IS
  'Когда человек последний раз заходил ИМЕННО внедренцем. Не дубль '
  'clients.last_login_at: там про его собственный кабинет.';

GRANT SELECT, INSERT, UPDATE, DELETE ON tech_specialists TO plusson;
