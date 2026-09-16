-- 424: права роли `plusson` на таблицы системы техспецов (пропущены в 416-419).
--
-- ⚠️⚠️ РОЛЬ `plusson` НЕ ВЛАДЕЛЕЦ ТАБЛИЦ — БЕЗ GRANT API ОТВЕЧАЕТ 500
-- `permission denied for table …`. Миграции накатываются от `postgres`, он и
-- становится владельцем новой таблицы; приложение ходит в базу под `plusson`.
--
-- Поймано на проде 16.09.2026: админка падала с Application error на разделе
-- «Клиенты». В логах — `permission denied for table tech_qualification_tiers`
-- на `GET /api/v1/admin/tech/rates`. Проверка по всей базе нашла ШЕСТЬ таких
-- таблиц: права забыли в нескольких миграциях подряд.
--
-- ⚠️ Это уже третий случай подряд (397 промокоды, 422 platform_settings и
-- теперь эти). Правило записано в обеих прошлых миграциях и всё равно
-- забывается: ЗАВЁЛ ТАБЛИЦУ → СРАЗУ GRANT, в той же миграции.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tech_bonus_funds,
  tech_bonus_weights,
  tech_fund_tiers,
  tech_qualification_tiers,
  tech_quarter_requirements,
  tech_role_history
TO plusson;

-- Последовательности: без них INSERT упадёт на `nextval`, даже когда права на
-- саму таблицу выданы. Выдаём только существующим — таблица могла быть создана
-- без serial-ключа.
DO $$
DECLARE s record;
BEGIN
  FOR s IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
       AND c.relname LIKE 'tech_%'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO plusson', s.relname);
  END LOOP;
END $$;
