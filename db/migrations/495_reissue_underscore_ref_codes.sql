-- 495. Перевыпуск реф-кодов, содержащих «_» (23.09.2026)
--
-- ЗАЧЕМ. Коды апрельского импорта выглядят как `tg_392695076` / `sp_2a1a351a`.
-- Стартовый параметр ссылки — одна слитная строка `ref_pg{slug}_pid{код}_cid{N}`,
-- и разбор резал её по «_»: до системы доезжал огрызок `tg`. Контакта с таким
-- кодом нет → реферер оставался пустым, человек записывался как «пришёл сам».
-- Разбор починен (start_param.py), но коды с «_» остаются миной: любой новый
-- обработчик ссылок снова может на них наступить. Убираем причину.
--
-- ЧТО ДЕЛАЕМ.
--   1) Каждому контакту со «_» в ref_code выдаём новый код нового образца:
--      8 символов из алфавита contact_merge.generate_ref_code (без 0/O/1/I).
--   2) Старый код кладём в merged_ref_codes — resolve_ref_code ищет и там,
--      поэтому УЖЕ РАЗОСЛАННЫЕ ссылки продолжают работать.
--   3) Переписываем event_participants.referrer_ref_code на новый код —
--      чтобы в базе везде стоял один актуальный код человека.
--
-- ⚠️ ЭЛИНА БУТЕНКО (contacts.id = 4732, `tg_392695076`) — НЕ ТРОГАЕМ.
-- Действующий спикер, ссылки со старым кодом уже у людей на руках. Разбор
-- ссылок починен, поэтому её код теперь доезжает целиком и без перевыпуска.
-- Её 4 записи в event_participants тоже остаются как есть.
--
-- ОБЪЁМ на момент написания: 95 контактов со «_» (все у клиента 1) → 94 к
-- перевыпуску; 243 записи в event_participants → 239 к переписи.
--
-- ОТКАТ: таблица _bak_495_ref_codes хранит (contact_id, old_code, new_code).
-- Вернуть можно UPDATE-ом из неё; она намеренно НЕ удаляется в конце.

BEGIN;

-- ── 1. Бэкап ДО изменений ────────────────────────────────────────────────
-- ⚠️ Сначала снимок, потом правки: без него откат невозможен, а перевыпуск
-- затрагивает боевые реф-коды живых спикеров.
DROP TABLE IF EXISTS _bak_495_ref_codes;
CREATE TABLE _bak_495_ref_codes (
    contact_id  INTEGER PRIMARY KEY,
    old_code    TEXT NOT NULL,
    new_code    TEXT,
    name        TEXT,
    client_id   INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _bak_495_ref_codes (contact_id, old_code, name, client_id)
SELECT id, ref_code, name, client_id
  FROM contacts
 WHERE ref_code LIKE '%\_%'
   AND id <> 4732;          -- Элина Бутенко — исключение, см. шапку

-- ── 2. Генерация новых кодов ─────────────────────────────────────────────
-- Алфавит и длина — как в contact_merge.generate_ref_code: 8 символов,
-- без 0/O/1/I (их путают при переписывании от руки).
--
-- ⚠️ Уникальность: на contacts.ref_code стоит UNIQUE. Крутим цикл, пока код
-- не окажется свободным И не совпадёт с уже выданным в этом же прогоне —
-- случайность без проверки рано или поздно даст коллизию и обрушит миграцию.
DO $$
DECLARE
    r           RECORD;
    alphabet    TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    candidate   TEXT;
    i           INTEGER;
    tries       INTEGER;
BEGIN
    FOR r IN SELECT contact_id FROM _bak_495_ref_codes ORDER BY contact_id LOOP
        tries := 0;
        LOOP
            candidate := '';
            FOR i IN 1..8 LOOP
                candidate := candidate ||
                    substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
            END LOOP;

            EXIT WHEN NOT EXISTS (SELECT 1 FROM contacts WHERE ref_code = candidate)
                  AND NOT EXISTS (SELECT 1 FROM _bak_495_ref_codes WHERE new_code = candidate);

            tries := tries + 1;
            IF tries > 100 THEN
                RAISE EXCEPTION 'Не удалось подобрать свободный ref_code за 100 попыток';
            END IF;
        END LOOP;

        UPDATE _bak_495_ref_codes SET new_code = candidate WHERE contact_id = r.contact_id;
    END LOOP;
END $$;

-- Страховка: ни одной строки без нового кода быть не должно.
DO $$
DECLARE missing INTEGER;
BEGIN
    SELECT count(*) INTO missing FROM _bak_495_ref_codes WHERE new_code IS NULL;
    IF missing > 0 THEN
        RAISE EXCEPTION 'У % строк не сгенерирован new_code', missing;
    END IF;
END $$;

-- ── 3. Контакты: новый код + старый в merged_ref_codes ───────────────────
-- ⚠️ Старый код ОБЯЗАН попасть в merged_ref_codes: по нему resolve_ref_code
-- находит человека, и ссылки, уже разосланные людям, не превращаются в тыкву.
UPDATE contacts c
   SET ref_code         = b.new_code,
       merged_ref_codes = COALESCE(c.merged_ref_codes, '[]'::jsonb) || to_jsonb(b.old_code),
       updated_at       = now()
  FROM _bak_495_ref_codes b
 WHERE c.id = b.contact_id;

-- ── 4. Участники: «кто привёл» на новый код ──────────────────────────────
-- Записи, где старый код стоит как реферер. Элинин `tg_392695076` сюда не
-- попадает: его нет в _bak_495_ref_codes.
UPDATE event_participants ep
   SET referrer_ref_code = b.new_code
  FROM _bak_495_ref_codes b
 WHERE ep.referrer_ref_code = b.old_code;

-- ── 5. Проверки ──────────────────────────────────────────────────────────
DO $$
DECLARE
    left_contacts INTEGER;
    left_parts    INTEGER;
    dupes         INTEGER;
BEGIN
    -- Со «_» должна остаться РОВНО одна строка — Элина (4732).
    SELECT count(*) INTO left_contacts
      FROM contacts WHERE ref_code LIKE '%\_%';
    IF left_contacts <> 1 THEN
        RAISE EXCEPTION 'Ожидали 1 контакт со «_» (Элина), осталось %', left_contacts;
    END IF;

    -- В участниках — только её код.
    SELECT count(*) INTO left_parts
      FROM event_participants
     WHERE referrer_ref_code LIKE '%\_%'
       AND referrer_ref_code <> 'tg_392695076';
    IF left_parts <> 0 THEN
        RAISE EXCEPTION 'Остались участники со старым кодом: %', left_parts;
    END IF;

    -- Дублей быть не может (UNIQUE), но проверяем явно — цена ошибки высока.
    SELECT count(*) INTO dupes FROM (
        SELECT ref_code FROM contacts WHERE ref_code IS NOT NULL
         GROUP BY ref_code HAVING count(*) > 1
    ) q;
    IF dupes > 0 THEN
        RAISE EXCEPTION 'Дубли ref_code: %', dupes;
    END IF;
END $$;

COMMIT;
