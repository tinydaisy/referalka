-- 496. Перевыпуск реф-кода контакта 10664 (23.09.2026)
--
-- ЗАЧЕМ. Элина Бутенко (второй телеграм `elina_cifrolog` + рабочая почта) имеет
-- код `i62ah2ss` — старый строчный формат. Он рабочий (подчёркивания нет, см.
-- миграцию 495), но неустойчив к переписыванию руками: `i` путают с единицей,
-- а поиск идёт по ТОЧНОМУ совпадению — `I62AH2SS` уже не найдётся.
-- Новый образец (заглавные, без 0/O/1/I) от этого защищён.
--
-- ⚠️ НЕ ПУТАТЬ с контактом 4732 «Элина Бутенко ПРОДЮСЕР» (`tg_392695076`) —
-- это ДРУГОЙ телеграм-аккаунт (`mrs_elinabutenko`, id 392695076 против
-- 7976854412). 4732 — действующий спикер, её код намеренно НЕ трогаем.
--
-- ЧТО ДЕЛАЕМ.
--   1) Новый код нового образца контакту 10664.
--   2) Старый `i62ah2ss` → merged_ref_codes (уже разосланные ссылки живут).
--   3) 1 запись event_participants → новый код (Александр Самойлов, contact
--      4563, событие 4). В product_orders и referral_events кода нет — 0 строк.
--
-- ОТКАТ: _bak_496_ref_code хранит (contact_id, old_code, new_code).

BEGIN;

DROP TABLE IF EXISTS _bak_496_ref_code;
CREATE TABLE _bak_496_ref_code (
    contact_id  INTEGER PRIMARY KEY,
    old_code    TEXT NOT NULL,
    new_code    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ⚠️ Берём строку по id И по коду: если код уже перевыпущен (миграцию
-- запустили дважды), строк не будет и миграция отработает вхолостую,
-- а не выдаст человеку второй новый код поверх первого.
INSERT INTO _bak_496_ref_code (contact_id, old_code)
SELECT id, ref_code FROM contacts WHERE id = 10664 AND ref_code = 'i62ah2ss';

-- Новый код: алфавит и длина как в contact_merge.generate_ref_code.
DO $$
DECLARE
    alphabet  TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    candidate TEXT;
    i         INTEGER;
    tries     INTEGER := 0;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM _bak_496_ref_code) THEN
        RAISE NOTICE 'Контакт 10664 с кодом i62ah2ss не найден — уже перевыпущен, пропускаем';
        RETURN;
    END IF;

    LOOP
        candidate := '';
        FOR i IN 1..8 LOOP
            candidate := candidate ||
                substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
        END LOOP;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE ref_code = candidate);
        tries := tries + 1;
        IF tries > 100 THEN
            RAISE EXCEPTION 'Не удалось подобрать свободный ref_code за 100 попыток';
        END IF;
    END LOOP;

    UPDATE _bak_496_ref_code SET new_code = candidate WHERE contact_id = 10664;
END $$;

-- Контакт: новый код, старый в merged_ref_codes.
UPDATE contacts c
   SET ref_code         = b.new_code,
       merged_ref_codes = COALESCE(c.merged_ref_codes, '[]'::jsonb) || to_jsonb(b.old_code),
       updated_at       = now()
  FROM _bak_496_ref_code b
 WHERE c.id = b.contact_id AND b.new_code IS NOT NULL;

-- Тот, кто пришёл по её ссылке.
UPDATE event_participants ep
   SET referrer_ref_code = b.new_code
  FROM _bak_496_ref_code b
 WHERE ep.referrer_ref_code = b.old_code AND b.new_code IS NOT NULL;

-- ── Проверки ─────────────────────────────────────────────────────────────
DO $$
DECLARE
    left_old  INTEGER;
    left_part INTEGER;
    prodyuser TEXT;
BEGIN
    SELECT count(*) INTO left_old FROM contacts WHERE ref_code = 'i62ah2ss';
    IF left_old <> 0 THEN
        RAISE EXCEPTION 'Старый код всё ещё у контакта: %', left_old;
    END IF;

    SELECT count(*) INTO left_part
      FROM event_participants WHERE referrer_ref_code = 'i62ah2ss';
    IF left_part <> 0 THEN
        RAISE EXCEPTION 'Остались участники со старым кодом: %', left_part;
    END IF;

    -- ⚠️ Страховка от промаха по соседнему контакту: код спикера 4732 обязан
    -- остаться нетронутым.
    SELECT ref_code INTO prodyuser FROM contacts WHERE id = 4732;
    IF prodyuser IS DISTINCT FROM 'tg_392695076' THEN
        RAISE EXCEPTION 'Код контакта 4732 изменён (%), а не должен был', prodyuser;
    END IF;
END $$;

COMMIT;
