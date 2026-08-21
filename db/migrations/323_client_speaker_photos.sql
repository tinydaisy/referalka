-- 323: библиотека фото спикера в профиле клиента
--
-- Зачем. У человека несколько удачных снимков, и организатору нужно дать выбор:
-- пусть скачает тот, который подойдёт под его афишу. Одного owner_photo_url мало.
--
-- ⚠️ Устроено ТАК ЖЕ, как библиотека афиш коллаба (collaborator_posters, мигр. 121):
-- отдельная таблица с подписью и порядком, а не JSONB-массив в clients. Причина —
-- у картинок есть жизненный цикл (загрузка в R2, переименование, удаление с чисткой
-- файла, перетаскивание), и в JSONB это неудобно.
--
-- ⚠️ Старое поле clients.owner_photo_url НЕ трогаем — на него завязаны Mini App,
-- лендинги и карточка основателя. Библиотека дополняет, а не заменяет: галочка
-- is_primary отмечает, какое фото показывается в профиле.

CREATE TABLE IF NOT EXISTS client_speaker_photos (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    url         TEXT    NOT NULL,
    label       TEXT,
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_speaker_photos_client
    ON client_speaker_photos (client_id, sort_order, id);

-- Главное фото — одно на клиента.
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_speaker_photos_primary
    ON client_speaker_photos (client_id) WHERE is_primary;

COMMENT ON TABLE client_speaker_photos IS
  'Библиотека фото спикера: организатор выбирает и скачивает нужное';

GRANT SELECT, INSERT, UPDATE, DELETE ON client_speaker_photos TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_speaker_photos_id_seq TO plusson;
