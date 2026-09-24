-- 512. Обложки выступлений — ПО ДНЮ И СПИКЕРУ, а не по записи (24.09.2026)
--
-- ЗАЧЕМ. Обложки собирались только по кускам нарезки эфира
-- (`webinar_recording_cuts.cover_url`), и связь была ЛОЖНОЙ: из записи в
-- картинку не попадает ничего — ни кадра, ни секунды. Запись служила лишь
-- способом узнать, какой спикер выступал. Но спикер, его тема и фото есть в
-- программе дня с самого начала.
--
-- Следствия старой привязки, на которые жаловался владелец:
--   • обложку нельзя приготовить ЗАРАНЕЕ — нужен состоявшийся эфир, запись и
--     расставленные метки нарезки;
--   • у записи без меток кусков не было вовсе, сборка молча возвращала ноль,
--     а интерфейс объяснял это «у спикера нет карточки» — причина не та.
--
-- Теперь обложка живёт на паре «день + спикер»: собирается по программе, до
-- эфира. Когда нарезка появится, кусок сопоставляется со спикером и берёт
-- готовую обложку.
--
-- ⚠️ `cover_url` у кусков НЕ УДАЛЯЕМ и старый путь сборки не трогаем: у уже
-- нарезанных кусков там лежат рабочие картинки, и перерисовать обложку под
-- конкретный кусок по-прежнему нужно.
--
-- ⚠️ day_number, а не conf_days.id: во всей вебинарной части день адресуется
-- номером (`webinar_rooms.day_number`, `conf_sessions.day`), и ссылка на id
-- разошлась бы с остальными таблицами.

CREATE TABLE IF NOT EXISTS event_speaker_covers (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    day_number  INTEGER NOT NULL,
    ec_id       INTEGER NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    cover_url   TEXT    NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Одному спикеру в одном дне — одна обложка. Слотов у него может быть
    -- несколько (открытие дня + выступление), но картинка нужна одна.
    UNIQUE (event_id, day_number, ec_id)
);

CREATE INDEX IF NOT EXISTS idx_esc_event_day
    ON event_speaker_covers (event_id, day_number);

-- ⚠️ GRANT в той же миграции: роль `plusson` не владелец таблиц, и без этого
-- приложение получит «permission denied» на первом же запросе.
GRANT SELECT, INSERT, UPDATE, DELETE ON event_speaker_covers TO plusson;
GRANT USAGE, SELECT ON SEQUENCE event_speaker_covers_id_seq TO plusson;

COMMENT ON TABLE event_speaker_covers IS
  'Обложки выступлений, собранные по программе дня (день + спикер). Не требуют записи эфира: готовятся заранее, нарезка берёт их по спикеру.';
