-- Миграция 187: восстановление пароля для админов
--
-- Раньше password_reset_tokens.client_id был NOT NULL (только клиенты).
-- Добавляем admin_id (NULL) и снимаем NOT NULL с client_id — токен теперь
-- принадлежит ЛИБО клиенту, ЛИБО админу.

ALTER TABLE password_reset_tokens
    ADD COLUMN IF NOT EXISTS admin_id INTEGER NULL REFERENCES admins(id) ON DELETE CASCADE;

ALTER TABLE password_reset_tokens
    ALTER COLUMN client_id DROP NOT NULL;

-- Ровно один из client_id / admin_id должен быть заполнен.
ALTER TABLE password_reset_tokens
    DROP CONSTRAINT IF EXISTS chk_reset_target_one;
ALTER TABLE password_reset_tokens
    ADD CONSTRAINT chk_reset_target_one
    CHECK ((client_id IS NOT NULL) <> (admin_id IS NOT NULL));
