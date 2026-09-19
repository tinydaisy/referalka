-- Один голос на человека: реакции спикерам и голоса в батлах (19.09.2026)
--
-- Зачем: счётчик просто прибавлял +1 на каждое нажатие — один человек мог
-- накрутить сколько угодно, и оценки спикеров ничего не значили.
--
-- ⚠️ Настройкой, а не жёстко: в некоторых форматах «жать сколько хочешь»
-- (аплодисменты, «огонь») — это осознанная механика вовлечения. Поэтому
-- галочка, по умолчанию ВЫКЛЮЧЕНА — поведение существующих комнат не
-- меняется само собой.
ALTER TABLE webinar_rooms
    ADD COLUMN IF NOT EXISTS one_vote_per_person BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN webinar_rooms.one_vote_per_person IS
    'Один человек = один голос спикеру и в батле (иначе можно жать много раз).';

-- Кто уже голосовал. ⚠️ Отдельная таблица, а не флаг в реакциях: считать
-- «сколько раз нажал вот этот человек» иначе неоткуда — в
-- webinar_speaker_reactions лежит только итоговое число.
CREATE TABLE IF NOT EXISTS webinar_votes (
    id           SERIAL PRIMARY KEY,
    room_id      INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    -- Что оценивали: 'speaker' (реакция спикеру) или 'battle' (игрок батла).
    target_kind  TEXT    NOT NULL,
    target_id    INTEGER NOT NULL,
    -- Кто: известный контакт ИЛИ аноним по ключу сессии. Заполнено одно из двух.
    contact_id   INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    session_key  TEXT,
    reaction_key TEXT    NOT NULL,
    -- ⚠️ Запуск эфира: после «Начать заново» голосование начинается с чистого
    -- листа, иначе вчерашние голоса блокировали бы сегодняшний эфир.
    session_id   INTEGER REFERENCES webinar_sessions(id) ON DELETE CASCADE,
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ⚠️ Два ЧАСТИЧНЫХ уникальных индекса вместо одного общего: в обычном UNIQUE
-- строки со значением NULL не конфликтуют между собой, поэтому аноним
-- (contact_id IS NULL) смог бы голосовать повторно сколько угодно раз.
-- COALESCE тут не годится — session_id тоже бывает NULL (голос вне эфира).
CREATE UNIQUE INDEX IF NOT EXISTS uq_webinar_votes_contact
    ON webinar_votes (room_id, target_kind, target_id, contact_id,
                      COALESCE(session_id, 0))
    WHERE contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webinar_votes_session
    ON webinar_votes (room_id, target_kind, target_id, session_key,
                      COALESCE(session_id, 0))
    WHERE contact_id IS NULL AND session_key IS NOT NULL;

-- ⚠️⚠️ GRANT В ТОЙ ЖЕ МИГРАЦИИ: миграции накатываются от postgres, а
-- приложение работает под ролью plusson. Без GRANT — permission denied уже
-- на первом голосе.
GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_votes TO plusson;
GRANT USAGE, SELECT ON SEQUENCE webinar_votes_id_seq TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_rooms TO plusson;
