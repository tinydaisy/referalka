-- 208: уровень доступа ассистента клиента
--
-- 'limited' (default, поведение как было) — урезанные права:
--   нет удаления «людей», нет Каналов, нет Настроек (email/пароль владельца),
--   лид-магниты только чтение, денежные разделы закрыты.
-- 'full' — абсолютно те же права, что у владельца кабинета,
--   ЗА ИСКЛЮЧЕНИЕМ управления самим ассистентом (/clients/me/assistant/*),
--   иначе ассистент может сменить себе пароль или удалить себя.

ALTER TABLE client_assistants
    ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'limited';

ALTER TABLE client_assistants
    DROP CONSTRAINT IF EXISTS client_assistants_access_level_check;

ALTER TABLE client_assistants
    ADD CONSTRAINT client_assistants_access_level_check
    CHECK (access_level IN ('full', 'limited'));
