-- 221. Вебинарная комната (стрим + чат + продажи + аналитика).
--
-- ЗАЧЕМ. Своя вебинарная комната на pluson.ru — как в GetCourse (тип трансляции
-- «Видеокодер»): Zoom → видеокодер → RTMP на наш MediaMTX → HLS-плеер на странице
-- события, рядом чат, продающие блоки (кнопки + формы заявок), реакции по спикерам
-- (👍/👎 с редактируемыми названиями, 👎 отключаемая), опросы, батлы, авто-кнопка
-- «Подписаться на спикера» и подарок спикера по таймингу слота. Плюс аналитика
-- «сколько людей по часам» (heartbeat присутствия) и активность каждого зрителя
-- (сообщения/реакции) — фундамент под игровые механики.
--
-- Комната привязана к ДНЮ события (по conf_days.day_number, как вся программа проекта),
-- не к событию целиком. Гейт по фиче: webinar_room (Экстра) — своя комната;
-- webinar_link (Профи+) — только ссылка на стороннюю комнату.
--
-- Владелец события — в event_owners (у events НЕТ client_id, мигр. 137).

BEGIN;

-- ── Модуль (для будущего отдельного типа события, напр. «Батлы») ──────────────
INSERT INTO modules (slug, name, description, is_active)
VALUES ('battle', 'Батлы', 'Батлы спикеров с реакциями в эфире', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- ── Фичи гейтинга ────────────────────────────────────────────────────────────
INSERT INTO features (slug, name, description, sort) VALUES
  ('webinar_room', 'Вебинарная комната', 'Своя вебинарная комната: стрим через видеокодер, чат, продающие блоки, аналитика', 40),
  ('webinar_link', 'Ссылка на вебинар', 'Кнопка на стороннюю вебинарную комнату (без своей комнаты)', 41)
ON CONFLICT (slug) DO NOTHING;

-- Привязка фич к тарифам:
--   webinar_room → Экстра (vip)
--   webinar_link → Профи (pro) и Экстра (vip)
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE f.slug = 'webinar_room' AND t.slug IN ('vip')
ON CONFLICT DO NOTHING;

INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE f.slug = 'webinar_link' AND t.slug IN ('pro', 'vip')
ON CONFLICT DO NOTHING;

-- Триал = Профи по фичам (правило проекта): дадим триалу webinar_room, чтобы демо
-- Экстры работало (у trial мы зеркалим pro-фичи; вебинар — топовая, но для демо ок).
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE f.slug IN ('webinar_room', 'webinar_link') AND t.slug = 'trial'
ON CONFLICT DO NOTHING;

-- ── Комната на день ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_rooms (
    id                  SERIAL PRIMARY KEY,
    event_id            INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    day_number          INTEGER NOT NULL,                 -- связь с conf_days.day_number (JOIN по event_id+day_number)
    title               TEXT,                             -- название дня-вебинара (правится), fallback «День N»
    starts_at           TIMESTAMPTZ,                      -- дата/время эфира дня

    stream_type         TEXT NOT NULL DEFAULT 'encoder',  -- encoder (свой MediaMTX) | external_link (Профи)
    stream_key          TEXT,                             -- секретный ключ потока для видеокодера
    hls_url             TEXT,                             -- откуда плеер берёт HLS (наш MediaMTX)
    external_url        TEXT,                             -- внешняя ссылка на стороннюю комнату (Профи)

    status              TEXT NOT NULL DEFAULT 'idle',     -- idle | live | ended
    hide_viewer_count   BOOLEAN NOT NULL DEFAULT FALSE,   -- скрывать число зрителей в эфире
    chat_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    premoderation       BOOLEAN NOT NULL DEFAULT FALSE,
    redirect_url        TEXT,                             -- куда перебросить зрителя после завершения

    -- реакции на спикеров: редактируемые названия + показывать ли отрицательную
    reaction_up_label   TEXT NOT NULL DEFAULT 'Огонь',
    reaction_down_label TEXT NOT NULL DEFAULT 'Слабо',
    show_down_reaction  BOOLEAN NOT NULL DEFAULT TRUE,

    intro_text          TEXT,                             -- текст «до эфира»
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, day_number)                         -- одна комната на день события
);
CREATE INDEX IF NOT EXISTS idx_webinar_rooms_event ON webinar_rooms(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS webinar_rooms_stream_key_uq
    ON webinar_rooms(stream_key) WHERE stream_key IS NOT NULL;

-- ── Присутствие (heartbeat, база для «сколько онлайн по времени») ─────────────
CREATE TABLE IF NOT EXISTS webinar_presence (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    session_key TEXT,                                     -- для анонимов без contact_id
    bucket_at   TIMESTAMPTZ NOT NULL,                     -- минута heartbeat (усечённая до минуты)
    device      TEXT,                                     -- desktop | mobile
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- одна точка в минуту на зрителя → уникальные онлайн
CREATE UNIQUE INDEX IF NOT EXISTS webinar_presence_uq
    ON webinar_presence(room_id, COALESCE(contact_id, 0), COALESCE(session_key, ''), bucket_at);
CREATE INDEX IF NOT EXISTS idx_webinar_presence_room_bucket ON webinar_presence(room_id, bucket_at);

-- ── Чат ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_chat_messages (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    author_name TEXT,                                     -- отображаемое имя (кеш на момент отправки)
    text        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'visible',          -- visible | hidden | premod
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_chat_room ON webinar_chat_messages(room_id, at);

-- бан/удаление участника из эфира и чата
CREATE TABLE IF NOT EXISTS webinar_banned (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    session_key TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_banned_room ON webinar_banned(room_id);

-- ── Продающие блоки ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_blocks (
    id            SERIAL PRIMARY KEY,
    room_id       INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                          -- button | form | speaker_follow | gift
    title         TEXT,
    url           TEXT,                                   -- для button
    body          TEXT,                                   -- подпись/описание блока
    form_fields   JSONB NOT NULL DEFAULT '[]'::jsonb,     -- для form: [{key,label,required}]
    form_tag      TEXT,                                   -- тег-«группа», который вешаем на контакт
    follow_mode   TEXT,                                   -- speaker_follow/gift: auto (текущий спикер по слоту) | fixed
    speaker_id    INTEGER,                                -- fixed: event_collaborators.id
    is_pinned     BOOLEAN NOT NULL DEFAULT FALSE,         -- показан прямо сейчас (пульт ведущего)
    show_at_min   INTEGER,                                -- тайминг появления (мин от старта)
    hide_at_min   INTEGER,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_blocks_room ON webinar_blocks(room_id, sort_order);

-- ── Единый поток активности (по зрителю — фундамент геймификации) ─────────────
CREATE TABLE IF NOT EXISTS webinar_activity (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    session_key TEXT,
    kind        TEXT NOT NULL,                            -- click | form_submit | order | payment | reaction | poll_vote | chat_msg
    target_kind TEXT,                                     -- block | speaker | poll_option | battle_player
    target_id   INTEGER,
    value       TEXT,                                     -- напр. up/down у реакции
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_activity_room_at ON webinar_activity(room_id, at);
CREATE INDEX IF NOT EXISTS idx_webinar_activity_contact ON webinar_activity(room_id, contact_id);

-- ── Счётчики реакций спикерам (денормализация для быстрого показа) ────────────
CREATE TABLE IF NOT EXISTS webinar_speaker_reactions (
    id            SERIAL PRIMARY KEY,
    room_id       INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    speaker_id    INTEGER NOT NULL,                       -- event_collaborators.id
    reaction_key  TEXT NOT NULL,                          -- up | down
    count         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (room_id, speaker_id, reaction_key)
);

-- ── Опросы / голосования ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_polls (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    question    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft',            -- draft | open | closed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_polls_room ON webinar_polls(room_id);

CREATE TABLE IF NOT EXISTS webinar_poll_options (
    id          SERIAL PRIMARY KEY,
    poll_id     INTEGER NOT NULL REFERENCES webinar_polls(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    votes       INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webinar_poll_options_poll ON webinar_poll_options(poll_id);

-- один голос от зрителя на опрос
CREATE TABLE IF NOT EXISTS webinar_poll_votes (
    id          SERIAL PRIMARY KEY,
    poll_id     INTEGER NOT NULL REFERENCES webinar_polls(id) ON DELETE CASCADE,
    option_id   INTEGER NOT NULL REFERENCES webinar_poll_options(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    session_key TEXT,
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS webinar_poll_votes_uq
    ON webinar_poll_votes(poll_id, COALESCE(contact_id, 0), COALESCE(session_key, ''));

-- ── Батлы ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_battles (
    id                  SERIAL PRIMARY KEY,
    room_id             INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    title               TEXT,
    status              TEXT NOT NULL DEFAULT 'draft',    -- draft | live | ended
    reaction_up_label   TEXT NOT NULL DEFAULT 'Огонь',
    reaction_down_label TEXT NOT NULL DEFAULT 'Слабо',
    show_down_reaction  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webinar_battles_room ON webinar_battles(room_id);

CREATE TABLE IF NOT EXISTS webinar_battle_players (
    id          SERIAL PRIMARY KEY,
    battle_id   INTEGER NOT NULL REFERENCES webinar_battles(id) ON DELETE CASCADE,
    speaker_id  INTEGER,                                  -- event_collaborators.id (выбор из события)
    name        TEXT,                                     -- кеш имени спикера
    up_count    INTEGER NOT NULL DEFAULT 0,
    down_count  INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_webinar_battle_players_battle ON webinar_battle_players(battle_id);

-- голоса в батле — один зритель, один игрок, up/down (можно менять решение)
CREATE TABLE IF NOT EXISTS webinar_battle_votes (
    id          SERIAL PRIMARY KEY,
    battle_id   INTEGER NOT NULL REFERENCES webinar_battles(id) ON DELETE CASCADE,
    player_id   INTEGER NOT NULL REFERENCES webinar_battle_players(id) ON DELETE CASCADE,
    contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    session_key TEXT,
    reaction_key TEXT NOT NULL,                           -- up | down
    at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS webinar_battle_votes_uq
    ON webinar_battle_votes(player_id, COALESCE(contact_id, 0), COALESCE(session_key, ''));

-- ── Регистрация тех, кого нет в базе ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webinar_registrations (
    id          SERIAL PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_webinar_registrations_room ON webinar_registrations(room_id);

-- ── GRANT-ы (роль plusson не владелец таблиц) ────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
    webinar_rooms, webinar_presence, webinar_chat_messages, webinar_banned,
    webinar_blocks, webinar_activity, webinar_speaker_reactions,
    webinar_polls, webinar_poll_options, webinar_poll_votes,
    webinar_battles, webinar_battle_players, webinar_battle_votes,
    webinar_registrations
    TO plusson;

GRANT USAGE, SELECT ON SEQUENCE
    webinar_rooms_id_seq, webinar_presence_id_seq, webinar_chat_messages_id_seq,
    webinar_banned_id_seq, webinar_blocks_id_seq, webinar_activity_id_seq,
    webinar_speaker_reactions_id_seq, webinar_polls_id_seq, webinar_poll_options_id_seq,
    webinar_poll_votes_id_seq, webinar_battles_id_seq, webinar_battle_players_id_seq,
    webinar_battle_votes_id_seq, webinar_registrations_id_seq
    TO plusson;

COMMIT;
