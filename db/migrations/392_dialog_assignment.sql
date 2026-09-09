-- 392. Распределение диалогов из @pluson_bot между внедренцами.
--
-- В @pluson_bot пишут не только клиенты платформы: человек может задать вопрос,
-- ещё не будучи никем. Его диалог тоже надо кому-то поручить, иначе он висит
-- ничей и на него никто не отвечает.
--
-- ⚠️⚠️ НАЗНАЧЕНИЕ НА КОНТАКТЕ, А НЕ НА СООБЩЕНИИ. Разговор ведёт один человек:
-- пометка на каждом сообщении означала бы, что половину переписки разбирает
-- один внедренец, половину другой, и оба видят обрывки.
--
-- ⚠️ Отдельная таблица, а не колонка в `contacts`: назначение относится к
-- ПЕРЕПИСКЕ, а не к человеку. Один и тот же контакт живёт в базах разных
-- клиентов (`contacts` — строка на клиента), и колонка там означала бы
-- «ответственный за контакт клиента», чего мы не имеем в виду.

CREATE TABLE IF NOT EXISTS dialog_assignments (
    id         SERIAL PRIMARY KEY,
    -- В чьей базе идёт переписка. Для @pluson_bot это системный кабинет.
    client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    spec_id    INTEGER REFERENCES tech_specialists(id) ON DELETE SET NULL,

    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Кто назначил: 'admin' или 'auto'. Пригодится, когда появится
    -- автораспределение — по нему будет видно, ручное это или машинное.
    assigned_by TEXT NOT NULL DEFAULT 'admin',
    note       TEXT,

    -- Один разговор — один ответственный.
    UNIQUE (client_id, contact_id)
);

CREATE INDEX IF NOT EXISTS ix_dialog_assign_spec
    ON dialog_assignments (spec_id, assigned_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON dialog_assignments TO plusson;
GRANT USAGE, SELECT ON dialog_assignments_id_seq TO plusson;
