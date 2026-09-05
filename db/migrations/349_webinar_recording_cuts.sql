-- 349: Нарезка записи эфира на куски по спикерам.
--
-- Зачем. MediaMTX пишет ВЕСЬ поток RTMP — с момента, как включили Zoom/OBS, а
-- не с момента «Начать эфир». В файле лежат проверка звука, «слышно меня» и
-- ожидание опоздавших. Дальше внутри эфира идут открытие и выступления разных
-- спикеров подряд — одним файлом это никому не отдать: спикеру нужно своё
-- выступление, покупателю — список по именам.
--
-- Решение: смещение эфира в записи считается САМО (из времени первого сегмента
-- и started_at сессии), а границы между спикерами клиент расставляет в
-- редакторе — по программе дня одной кнопкой, с поправкой мышкой.

-- ── 1. Смещение эфира внутри склеенного файла ────────────────────────────────
-- ⚠️ Физически НЕ обрезаем. Обрезка часового файла — это скачать гигабайты из
-- хранилища, пережать и залить обратно; смещение — одно число, и его можно
-- поправить, если «Начать эфир» нажали неточно. Из отрезанного файла вернуть
-- уже ничего нельзя.
--
-- ⚠️ NULL = смещение неизвестно (старые записи, у которых куски уже удалены, и
-- время первого сегмента взять неоткуда). Это НЕ то же, что 0 — при NULL
-- редактор не предлагает автораскладку по программе, а просит поставить метки
-- руками. Иначе метки уехали бы на неизвестную величину.
ALTER TABLE webinar_recordings
  ADD COLUMN IF NOT EXISTS live_offset_sec INTEGER;

COMMENT ON COLUMN webinar_recordings.live_offset_sec IS
  'На какой секунде склеенного файла нажали «Начать эфир». NULL = неизвестно.';

-- ── 2. Куски записи ──────────────────────────────────────────────────────────
-- ⚠️ Одна палочка = одна граница: кусок начинается там, где кончился предыдущий.
-- Поэтому храним start_sec/end_sec, а не «границы» отдельной сущностью — так
-- проще отдавать кусок наружу (у него есть длительность и свой файл).
--
-- ⚠️ Перерывы НЕ вырезаем (решение владельца): пауза после выступления попадает
-- в кусок предыдущего спикера.
CREATE TABLE IF NOT EXISTS webinar_recording_cuts (
    id            SERIAL PRIMARY KEY,
    recording_id  INTEGER NOT NULL REFERENCES webinar_recordings(id) ON DELETE CASCADE,

    -- Секунды ОТ НАЧАЛА ЭФИРА (не от начала файла): клиент видит таймлайн с
    -- нуля на «Начать эфир», и метки должны совпадать с тем, что он видит.
    -- Смещение live_offset_sec прибавляется только в момент резки ffmpeg.
    start_sec     INTEGER NOT NULL CHECK (start_sec >= 0),
    end_sec       INTEGER CHECK (end_sec IS NULL OR end_sec > start_sec),

    title         TEXT NOT NULL,
    -- ⚠️ event_collaborators.id (карточка человека В ЭТОМ событии), а не
    -- collaborators.id — как в conf_sessions.speaker_id. ON DELETE SET NULL:
    -- убрали спикера из состава — кусок остаётся, просто становится ничьим.
    speaker_ec_id INTEGER REFERENCES event_collaborators(id) ON DELETE SET NULL,
    -- Откуда взялась метка: из какого слота программы. Нужно, чтобы при
    -- повторной раскладке не плодить дубли и понимать, что клиент правил руками.
    session_id    INTEGER REFERENCES conf_sessions(id) ON DELETE SET NULL,

    sort_order    INTEGER NOT NULL DEFAULT 0,

    -- Результат нарезки. Пока NULL — кусок существует только как метка.
    status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'processing', 'ready', 'failed')),
    url           TEXT,
    r2_key        TEXT,
    size_bytes    BIGINT,
    duration_sec  INTEGER,
    error         TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wrec_cuts_recording
    ON webinar_recording_cuts (recording_id, sort_order, start_sec);

-- Кусок спикера ищут из его кабинета — по человеку, а не по записи.
CREATE INDEX IF NOT EXISTS idx_wrec_cuts_speaker
    ON webinar_recording_cuts (speaker_ec_id) WHERE speaker_ec_id IS NOT NULL;

-- ⚠️ Роль plusson НЕ владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_recording_cuts TO plusson;
GRANT USAGE, SELECT ON SEQUENCE webinar_recording_cuts_id_seq TO plusson;
