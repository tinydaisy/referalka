-- 422: права роли `plusson` на таблицу platform_settings (пропущено в 421).
--
-- ⚠️⚠️ РОЛЬ `plusson` НЕ ВЛАДЕЛЕЦ ТАБЛИЦ — БЕЗ GRANT API ПОЛУЧИТ
-- `permission denied`. Миграции накатываются от `postgres`, он и становится
-- владельцем новой таблицы; приложение же ходит в базу под ролью `plusson`.
--
-- Поймано сразу после наката 421 на прод 16.09.2026: таблица создалась, а
-- `SELECT` под ролью приложения отвечал «permission denied for table
-- platform_settings». Публикация политики упала бы у первого же клиента —
-- текст берёт реквизиты провайдера именно отсюда.
--
-- ⚠️ То же правило записано в 397_promo_codes.sql. Правило есть — забыть о нём
-- в новой миграции всё равно легко, поэтому: ЗАВЁЛ ТАБЛИЦУ → СРАЗУ GRANT.
--
-- ⚠️ Последовательности у platform_settings нет (id — SMALLINT с DEFAULT 1,
-- не serial), поэтому GRANT USAGE ON SEQUENCE здесь не нужен.

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_settings TO plusson;
