-- 212: восстановление пароля для помощников кабинета (assistants).
-- Раньше password_reset_tokens поддерживал только client_id и admin_id,
-- из-за чего /password-reset для помощника отвечал «email не зарегистрирован».
-- Добавляем assistant_id и разрешаем «ровно один из трёх».

ALTER TABLE password_reset_tokens
    ADD COLUMN IF NOT EXISTS assistant_id INTEGER REFERENCES assistants(id) ON DELETE CASCADE;

ALTER TABLE password_reset_tokens DROP CONSTRAINT IF EXISTS chk_reset_target_one;

ALTER TABLE password_reset_tokens ADD CONSTRAINT chk_reset_target_one CHECK (
    (client_id IS NOT NULL)::int
  + (admin_id IS NOT NULL)::int
  + (assistant_id IS NOT NULL)::int = 1
);
