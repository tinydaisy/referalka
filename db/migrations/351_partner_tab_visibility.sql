-- 351: Вкладка «Партнёру» в Mini App — кому её показывать
--
-- Зачем (решение № 4). Третья вкладка Хаба рядом с «Календарь» и «О проекте».
-- Клиент решает, показывать её ВСЕМ (не-партнёр внутри видит условия и кнопку
-- «Стать партнёром») или ТОЛЬКО тем, кто уже партнёр.
--
--   'off'      — вкладки нет (по умолчанию: у кабинета без партнёрки её быть
--                не должно, иначе люди жмут на раздел, которого нет)
--   'partners' — только зарегистрированным партнёрам
--   'all'      — всем: вкладка работает как приглашение в программу
--
-- ⚠️ DEFAULT 'off', а не 'all': партнёрка сейчас только у admin, и у остальных
-- кабинетов пустая вкладка выглядела бы поломкой.
--
-- ⚠️ Название вкладки (`clients.tab_label_partner`) заведено миграцией 347 —
-- переименовывается клиентом, как остальные tab_label_* (решение № 3).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS partner_tab_visibility TEXT NOT NULL DEFAULT 'off';

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_partner_tab_visibility_chk;
ALTER TABLE clients ADD CONSTRAINT clients_partner_tab_visibility_chk
    CHECK (partner_tab_visibility IN ('off', 'partners', 'all'));

COMMENT ON COLUMN clients.partner_tab_visibility IS
  'Кому показывать вкладку «Партнёру» в Mini App: off (никому) | partners (только партнёрам) | all (всем, вкладка приглашает в программу). Решение № 4.';
