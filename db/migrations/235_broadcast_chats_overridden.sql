-- 235: флаг «настройки чатов рассылки переопределены вручную».
-- Проблема: галочки чатов (send_to_event/client/private_chats) у шаблонной рассылки
-- нельзя было СНЯТЬ — движок наследовал из шаблона, если у рассылки false
-- (tasks/broadcast.py: if not schedule.X and tmpl.X → True). Клиент снимал галочку,
-- сохранял, а рассылка всё равно слала в чаты.
-- Решение: если рассылку РЕДАКТИРОВАЛИ (chats_overridden=TRUE) — движок берёт
-- send_to_* СТРОГО из рассылки, шаблон не подмешивается. Нетронутые (FALSE) —
-- наследуют шаблон как раньше (обратная совместимость).

ALTER TABLE broadcast_schedules
  ADD COLUMN IF NOT EXISTS chats_overridden BOOLEAN NOT NULL DEFAULT FALSE;

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_schedules TO plusson;
