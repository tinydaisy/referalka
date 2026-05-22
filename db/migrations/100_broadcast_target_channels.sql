-- 100_broadcast_target_channels.sql
-- Выбор каналов отправки для рассылки.
--
-- Клиент в форме создания рассылки (произвольной или шаблонной) видит
-- список своих каналов с галочками. По умолчанию все включены.
-- Если он снимает галочку — рассылка не уходит через этот канал.
--
-- Семантика поля target_channel_ids:
--   NULL  → слать по всем каналам клиента (default, обратная совместимость)
--   []    → никуда не слать (полностью отключённая рассылка)
--   [3,11]→ слать только через channel_id 3 и 11
--
-- Применяется одинаково к шаблонам (broadcast_templates) и к произвольным
-- расписаниям (broadcast_schedules). При автогенерации расписаний из шаблона
-- (generate_schedules) значение копируется из шаблона в schedule.

BEGIN;

ALTER TABLE broadcast_templates
    ADD COLUMN IF NOT EXISTS target_channel_ids INTEGER[] NULL;

ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS target_channel_ids INTEGER[] NULL;

COMMENT ON COLUMN broadcast_templates.target_channel_ids IS
    'Опциональный фильтр каналов отправки. NULL = все каналы клиента, [] = никуда, [N,M] = только эти channel_id';
COMMENT ON COLUMN broadcast_schedules.target_channel_ids IS
    'Опциональный фильтр каналов отправки. Копируется из broadcast_templates.target_channel_ids при автогенерации; задаётся вручную для custom-рассылок';

COMMIT;
