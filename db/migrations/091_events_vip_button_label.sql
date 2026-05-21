-- 091_events_vip_button_label.sql
-- Кастомный текст кнопки VIP-тарифа в Mini App.
-- Кнопка показывается на вкладке «Программа» (над расписанием) и на вкладке
-- «Интро» (сразу после регистрации) — обе используют одно и то же название.
-- Если поле пустое — Mini App подставляет дефолт «Расшириться до VIP-тарифа».

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS vip_button_label TEXT NULL;
