-- Миграция 083: разрешить несколько подарков за одно и то же количество приведённых.
--
-- Раньше UNIQUE(event_id, threshold_count) запрещал клиенту иметь два разных
-- подарка с одинаковым порогом (например, 5 друзей → подарок A и подарок Б).
-- На практике клиенты хотят выдавать пакет из нескольких подарков за один порог
-- — снимаем ограничение.

ALTER TABLE event_referral_thresholds
    DROP CONSTRAINT IF EXISTS event_referral_thresholds_event_id_threshold_count_key;
