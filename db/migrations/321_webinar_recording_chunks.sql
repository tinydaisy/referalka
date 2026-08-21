-- 321: куски записи эфира заливаются В ХОДЕ трансляции, а не после (2026-08-21)
--
-- Зачем. MediaMTX пишет эфир на диск сервера, и до сих пор всё лежало там до
-- самого конца: двухчасовой эфир — это ~2 ГБ, а 50 одновременных эфиров дали бы
-- 110 ГБ при 17 ГБ свободных. Диск кончился бы на восьмом эфире, и легло бы ВСЁ
-- — база, рассылки, кабинет, а не только вебинары.
--
-- Теперь: сегмент дописан → сразу залит в хранилище → сразу удалён с диска.
-- На диске в любой момент один-два куска (~200 МБ) вместо целого эфира.
--
-- ⚠️ Писать сразу в хранилище, минуя диск, НЕЛЬЗЯ: MediaMTX умеет писать только
-- на файловую систему, а в S3 кладут готовый файл целиком — дописывать объект
-- по секундам в прямом эфире нечем.
--
-- ⚠️ Куски НЕ удаляются из хранилища после склейки сразу: сначала собирается и
-- заливается итоговый файл, и лишь потом чистятся куски. Иначе сбой склейки
-- уничтожил бы единственную копию эфира.

CREATE TABLE IF NOT EXISTS webinar_recording_chunks (
    id           BIGSERIAL PRIMARY KEY,
    room_id      INTEGER NOT NULL REFERENCES webinar_rooms(id) ON DELETE CASCADE,
    stream_key   TEXT    NOT NULL,          -- ключ потока (папка на диске)
    file_name    TEXT    NOT NULL,          -- имя сегмента, оно же метка времени
    r2_key       TEXT    NOT NULL,          -- где лежит в хранилище
    size_bytes   BIGINT  NOT NULL DEFAULT 0,
    seg_started_at TIMESTAMPTZ,             -- время начала куска (из имени файла)
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    session_id   INTEGER REFERENCES webinar_sessions(id) ON DELETE SET NULL,
    consumed_at  TIMESTAMPTZ               -- когда вошёл в склеенную запись
);

-- Один и тот же сегмент не должен заливаться дважды: сторож бегает по кругу и
-- обязан пропускать уже залитое.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webinar_chunk_file
    ON webinar_recording_chunks (stream_key, file_name);

-- Выборка кусков сессии для склейки — по потоку и времени.
CREATE INDEX IF NOT EXISTS idx_webinar_chunk_stream_time
    ON webinar_recording_chunks (stream_key, seg_started_at);

-- Уборка «ничьих» кусков: эфир не завершился штатно, склейки не было.
CREATE INDEX IF NOT EXISTS idx_webinar_chunk_unconsumed
    ON webinar_recording_chunks (uploaded_at) WHERE consumed_at IS NULL;

COMMENT ON TABLE webinar_recording_chunks IS
  'Куски записи эфира, залитые в хранилище ПО ХОДУ трансляции. После склейки '
  'итоговой записи помечаются consumed_at и удаляются из хранилища.';

-- ⚠️ Роль plusson не владелец таблиц — без GRANT API получит permission denied.
GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_recording_chunks TO plusson;
GRANT USAGE, SELECT ON SEQUENCE webinar_recording_chunks_id_seq TO plusson;
