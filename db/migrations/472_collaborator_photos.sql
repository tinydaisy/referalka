-- 472: библиотека фото спикера + выбор фото ДЛЯ КОНКРЕТНОЙ КОНФЕРЕНЦИИ.
--
-- ⚠️⚠️ ЗАЧЕМ. Фото у человека было одно (`collaborators.photo_url`), и загрузка
-- нового затирала прежнее. А под каждое событие фото готовят своё: «сейчас
-- карикатуры с улыбками, в другие разы какие-то предметы им делаю» (владелец,
-- 20.09.2026). Добавить вариант, не потеряв исходный, было нельзя вовсе.
--
-- ⚠️ Устроено ТАК ЖЕ, как библиотека афиш коллаба (`collaborator_posters`,
-- мигр. 121) и библиотека фото клиента (`client_speaker_photos`, мигр. 323):
-- отдельная таблица + ссылка из `event_collaborators` на выбранную строку.
-- Третий раз повторяем ту же форму сознательно — она уже проверена на афишах
-- и ведёт себя предсказуемо: у картинок есть жизненный цикл (загрузка в R2,
-- переименование, удаление с чисткой файла, перетаскивание), и в JSONB это
-- неудобно.
--
-- ⚠️⚠️ ТОЧКА ЛИЦА И КАДР — У КАЖДОГО ФОТО СВОИ. Это главное отличие от
-- `client_speaker_photos`, где есть только `focal`. Снимки кадрированы
-- по-разному: на одном лицо в центре, на другом сбоку, карикатура вообще
-- нарисована. Общая точка на всю библиотеку означала бы, что при
-- переключении варианта кадр разъезжается. Поэтому колонки кропа переезжают
-- в строку фото — те же, что у человека (мигр. 434 и 451).
--
-- ⚠️ `collaborators.photo_url` НЕ ТРОГАЕМ. Это профильное фото человека: оно
-- показывается в карточке спикера, в программе, в Mini App и на витрине.
-- Библиотека ДОПОЛНЯЕТ его для афиш конкретного события, а не заменяет.
--
-- Правило подстановки (одно на весь проект, см. `resolve_event_photo`):
--   event_collaborators.photo_id задан → берём это фото с ЕГО кропом;
--   не задан                          → collaborators.photo_url с его кропом.
-- Поэтому у тех, кто библиотекой не пользуется, ничего не меняется.

BEGIN;

CREATE TABLE IF NOT EXISTS collaborator_photos (
    id              SERIAL PRIMARY KEY,
    collaborator_id INTEGER NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
    url             TEXT    NOT NULL,
    -- Вырезка на прозрачном фоне к ЭТОМУ же варианту: на афишах с вырезками
    -- она своя у каждого снимка.
    cutout_url      TEXT,
    label           TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Точка лица и кадр — как у человека (мигр. 434, 451), но на каждое фото.
    photo_focal         TEXT,
    cutout_photo_focal  TEXT,
    crop_zoom_circle    NUMERIC(4,2) NOT NULL DEFAULT 1.0
        CHECK (crop_zoom_circle BETWEEN 0.3 AND 3.0),
    crop_zoom_square    NUMERIC(4,2) NOT NULL DEFAULT 1.0
        CHECK (crop_zoom_square BETWEEN 0.3 AND 3.0),
    crop_zoom_portrait  NUMERIC(4,2) NOT NULL DEFAULT 1.0
        CHECK (crop_zoom_portrait BETWEEN 0.3 AND 3.0),
    crop_dx_circle      NUMERIC(5,2) NOT NULL DEFAULT 0,
    crop_dy_circle      NUMERIC(5,2) NOT NULL DEFAULT 0,
    crop_dx_square      NUMERIC(5,2) NOT NULL DEFAULT 0,
    crop_dy_square      NUMERIC(5,2) NOT NULL DEFAULT 0,
    crop_dx_portrait    NUMERIC(5,2) NOT NULL DEFAULT 0,
    crop_dy_portrait    NUMERIC(5,2) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_collaborator_photos_coll
    ON collaborator_photos (collaborator_id, sort_order, id);

COMMENT ON TABLE collaborator_photos IS
  'Варианты фото спикера. Какой взят в конкретном событии — event_collaborators.photo_id';
COMMENT ON COLUMN collaborator_photos.photo_focal IS
  'Точка лица ЭТОГО снимка. У каждого варианта своя: карикатура и портрет '
  'кадрированы по-разному, общая точка разъезжалась бы при переключении';

-- Какое фото из библиотеки используется В ЭТОМ СОБЫТИИ.
-- ⚠️ ON DELETE SET NULL, а не CASCADE: удалили вариант фото — событие остаётся
-- и просто возвращается к профильному фото. CASCADE снёс бы спикера с события.
ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS photo_id INTEGER NULL
      REFERENCES collaborator_photos(id) ON DELETE SET NULL;

COMMENT ON COLUMN event_collaborators.photo_id IS
  'Фото из библиотеки, взятое для афиш ЭТОГО события. NULL — профильное фото';

GRANT SELECT, INSERT, UPDATE, DELETE ON collaborator_photos TO plusson;
GRANT USAGE, SELECT ON SEQUENCE collaborator_photos_id_seq TO plusson;

COMMIT;
