-- 276_addon_expiry_notifications.sql
-- Предупреждения об истечении купленного модуля (Конференции, Премии/Турниры,
-- Коллабораторная) за 7 / 3 / 1 день.
--
-- Зачем. Модуль истекал МОЛЧА: никакого события в системе не возникало, просто
-- переставала выдаваться фича. Клиент узнавал об этом постфактум — по тому, что
-- пропал раздел. А с 2026-08-10 у неоплаченного модуля ещё и останавливаются
-- спикерские рассылки, поэтому предупредить заранее стало обязательным:
-- иначе конференция «замолчит» посреди события.
--
-- Схема повторяет уже работающие уведомления о подписке
-- (client_subscriptions.notified_7d/3d/1d) — тот же принцип, тот же Celery-таск.

BEGIN;

ALTER TABLE client_addons ADD COLUMN IF NOT EXISTS notified_7d BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_addons ADD COLUMN IF NOT EXISTS notified_3d BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE client_addons ADD COLUMN IF NOT EXISTS notified_1d BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN client_addons.notified_7d IS 'Предупреждение за 7 дней отправлено (идемпотентность Celery-таска)';
COMMENT ON COLUMN client_addons.notified_3d IS 'Предупреждение за 3 дня отправлено';
COMMENT ON COLUMN client_addons.notified_1d IS 'Предупреждение за 1 день отправлено';

-- ⚠️ Флаги сбрасываются при ПРОДЛЕНИИ модуля: продление — это UPDATE expires_at
-- у той же строки (уникальный индекс uq_client_addon_active не даёт завести
-- вторую активную). Без сброса клиент, продливший модуль, не получил бы
-- предупреждений в следующий раз — таск считал бы, что уже уведомлял.
-- Сброс делает код выдачи модуля (addons.py), здесь только бэкфилл:
-- у активных модулей с далёкой датой окончания флаги заведомо не нужны.
UPDATE client_addons
   SET notified_7d = FALSE, notified_3d = FALSE, notified_1d = FALSE
 WHERE status = 'active' AND expires_at > NOW() + INTERVAL '7 days';

COMMIT;
