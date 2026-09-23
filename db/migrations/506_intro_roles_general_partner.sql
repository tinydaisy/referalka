-- 506. Генеральные партнёры в уже настроенных рассылках знакомства (23.09.2026)
--
-- ЗАЧЕМ. `general_partner` — ОТДЕЛЬНАЯ роль в БД, а не разновидность партнёра,
-- но галочки для неё в настройке шаблона не было вовсе. Фильтр сверяет роль
-- точным совпадением (`role = ANY(intro_roles)`), поэтому отметить «Партнёры»
-- не помогало: генеральные партнёры молча не попадали в «Знакомство со
-- спикером». Галочку добавили в интерфейс, но уже сохранённым спискам это не
-- поможет — их чиним здесь.
--
-- ⚠️ Дописываем ТОЛЬКО туда, где выбран `partner`. Клиент, отметивший
-- «Партнёры», имел в виду партнёров вообще — генеральный партнёр это тот же
-- партнёр, просто с бейджем. А где партнёров не выбирали (`{speaker}`), лезть
-- нельзя: это осознанный выбор «только спикеры», и наша догадка добавила бы в
-- рассылку людей, которых там не ждали.
--
-- ⚠️ `intro_roles IS NULL` не трогаем вовсе: NULL = «все роли», генеральные
-- партнёры туда и так попадают.
--
-- ОБЪЁМ на момент написания: 1 шаблон (id 377, событие 89).
--
-- ОТКАТ: _bak_506_intro_roles хранит прежние списки.

BEGIN;

DROP TABLE IF EXISTS _bak_506_intro_roles;
CREATE TABLE _bak_506_intro_roles (
    template_id  INTEGER PRIMARY KEY,
    old_roles    TEXT[],
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _bak_506_intro_roles (template_id, old_roles)
SELECT id, intro_roles
  FROM broadcast_templates
 WHERE intro_roles IS NOT NULL
   AND 'partner' = ANY(intro_roles)
   AND NOT ('general_partner' = ANY(intro_roles));

UPDATE broadcast_templates t
   SET intro_roles = t.intro_roles || ARRAY['general_partner']
  FROM _bak_506_intro_roles b
 WHERE t.id = b.template_id;

-- ── Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE left_cnt INTEGER;
BEGIN
    SELECT count(*) INTO left_cnt
      FROM broadcast_templates
     WHERE intro_roles IS NOT NULL
       AND 'partner' = ANY(intro_roles)
       AND NOT ('general_partner' = ANY(intro_roles));
    IF left_cnt <> 0 THEN
        RAISE EXCEPTION 'Остались шаблоны с partner без general_partner: %', left_cnt;
    END IF;
END $$;

COMMIT;
