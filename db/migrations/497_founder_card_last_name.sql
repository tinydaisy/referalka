-- 497. Фамилия в карточку основателя (23.09.2026)
--
-- ЗАЧЕМ. `ensure_self_collaborator` создавал карточку основателя из профиля
-- клиента, но `clients.last_name` в запрос не входил вовсе — в карточку
-- уезжало одно имя («Марго» вместо «Марго Форбс»), хотя у `collaborators`
-- поле `last_name` есть и просто оставалось пустым. Код починен; эта миграция
-- добирает тех, у кого карточка уже создана.
--
-- ЧТО ДЕЛАЕМ.
--   1) `collaborators.last_name` — фамилия клиента (СВОЁ поле, не склейка:
--      иначе DISPLAY_NAME_SQL выдал бы «Марго Форбс Форбс»).
--   2) `contacts.name` — а вот тут фамилия ПРИКЛЕИВАЕТСЯ: у контакта поля
--      фамилии нет вовсе, имя живёт целиком одной строкой.
--
-- ⚠️ ТОЛЬКО там, где имя в карточке СОВПАДАЕТ с именем клиента (34 из 37).
-- У трёх (клиенты 184, 185, 186) в карточке другой человек: «Мария» → «Роберт»,
-- «Ирина» → «Мария», «Мария» → «Ольга». Причина неизвестна — либо клиента
-- переименовали, либо шаг 2 функции («привязать самый ранний коллаб клиента»)
-- подцепил не того. Дописать туда чужую фамилию — испортить живые данные,
-- поэтому пропускаем: пусть лучше останется как есть.
--
-- ⚠️ Не трогаем карточки, где фамилия УЖЕ стоит: человек мог вписать её руками
-- иначе, чем в профиле клиента, и его правка важнее нашей.
--
-- ОТКАТ: _bak_497_founder_names хранит прежние значения.

BEGIN;

DROP TABLE IF EXISTS _bak_497_founder_names;
CREATE TABLE _bak_497_founder_names (
    collaborator_id INTEGER PRIMARY KEY,
    client_id       INTEGER NOT NULL,
    contact_id      INTEGER,
    old_collab_last TEXT,
    old_contact_name TEXT,
    new_last_name   TEXT,
    new_contact_name TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _bak_497_founder_names
    (collaborator_id, client_id, contact_id, old_collab_last, old_contact_name,
     new_last_name, new_contact_name)
SELECT co.id, cl.id, co.contact_id, co.last_name, ct.name,
       btrim(cl.last_name),
       btrim(btrim(cl.name) || ' ' || btrim(cl.last_name))
  FROM clients cl
  JOIN collaborators co ON co.id = cl.self_collaborator_id
  LEFT JOIN contacts ct ON ct.id = co.contact_id
 WHERE COALESCE(btrim(cl.last_name), '') <> ''
   AND COALESCE(btrim(co.last_name), '') = ''
   AND btrim(co.name) = btrim(cl.name);   -- тот же человек, см. шапку

-- 1. Фамилия — в своё поле карточки.
UPDATE collaborators co
   SET last_name = b.new_last_name
  FROM _bak_497_founder_names b
 WHERE co.id = b.collaborator_id;

-- 2. Контакт — имя целиком одной строкой.
-- ⚠️ Только если имя контакта совпадает с именем клиента: контакт могли
-- переименовать руками, и его версия важнее.
UPDATE contacts ct
   SET name = b.new_contact_name,
       updated_at = now()
  FROM _bak_497_founder_names b
 WHERE ct.id = b.contact_id
   AND btrim(ct.name) = btrim(b.old_contact_name)
   AND btrim(ct.name) <> btrim(b.new_contact_name);

-- ── Проверки ─────────────────────────────────────────────────────────────
DO $$
DECLARE
    left_empty INTEGER;
    doubled    INTEGER;
BEGIN
    -- Карточек без фамилии при заполненной у клиента и совпадающем имени
    -- остаться не должно.
    SELECT count(*) INTO left_empty
      FROM clients cl
      JOIN collaborators co ON co.id = cl.self_collaborator_id
     WHERE COALESCE(btrim(cl.last_name), '') <> ''
       AND COALESCE(btrim(co.last_name), '') = ''
       AND btrim(co.name) = btrim(cl.name);
    IF left_empty <> 0 THEN
        RAISE EXCEPTION 'Остались карточки без фамилии: %', left_empty;
    END IF;

    -- ⚠️ Фамилия не должна попасть ещё и в имя — иначе выйдет «Марго Форбс Форбс».
    SELECT count(*) INTO doubled
      FROM collaborators co
      JOIN _bak_497_founder_names b ON b.collaborator_id = co.id
     WHERE btrim(co.name) LIKE '%' || btrim(b.new_last_name);
    IF doubled > 0 THEN
        RAISE EXCEPTION 'Фамилия задвоилась в имени у % карточек', doubled;
    END IF;
END $$;

COMMIT;
