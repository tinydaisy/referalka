-- 294: Материал — страница из блоков, а не «тип + одна ссылка» (2026-08-14)
--
-- Зачем. В миграции 290 материал был примитивом: тип (видео/файл/ссылка/текст)
-- и один url. Так нельзя собрать нормальный урок — ни текст с картинками
-- написать, ни видео встроить рядом с файлами. Клиент прямо сказал: нужен
-- редактор как в GetCourse.
--
-- Теперь материал — набор блоков в нужном порядке:
--   text   — текст с форматированием (жирный, курсив, списки, ссылки);
--   image  — картинка;
--   video  — видео ПО ССЫЛКЕ (YouTube / VK Видео / Rutube), встраивается плеером;
--   file   — файл на скачивание (документ, презентация, архив);
--   audio  — аудио (голосовые, подкасты);
--   button — кнопка со ссылкой.
--
-- ⚠️ Своё видео НЕ храним (решение владельца): только ссылки на внешние
-- площадки. Хранение видео — это гигабайты и отдельный CDN, а у клиента
-- ролики и так лежат в VK/Rutube/YouTube.
--
-- ⚠️ Старые поля материала (kind/url/body/duration_sec/size_bytes) УДАЛЕНЫ
-- по решению владельца («удалить сделанное»): продукты ещё не в проде у
-- клиентов, переносить нечего. Останься они — были бы два способа задать
-- содержимое, и половина кода читала бы не ту половину данных.

BEGIN;

CREATE TABLE IF NOT EXISTS material_blocks (
    id          SERIAL PRIMARY KEY,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,

    kind        TEXT    NOT NULL
                CHECK (kind IN ('text', 'image', 'video', 'file', 'audio', 'button')),

    -- text: HTML из редактора; button: подпись; image/file/audio: подпись под
    -- вложением; video: заголовок над плеером.
    title       TEXT,
    body        TEXT,

    -- Ссылка: у video — на YouTube/VK/Rutube, у image/file/audio — на файл в
    -- R2, у button — куда ведёт.
    url         TEXT,

    -- Служебное у вложений: размер (подпись «4,2 МБ») и длительность.
    size_bytes  BIGINT,
    duration_sec INTEGER,

    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_material_blocks_material
    ON material_blocks(material_id, sort_order, id);

COMMENT ON TABLE material_blocks IS
    'Содержимое материала: текст, картинки, видео по ссылке, файлы, аудио, кнопки';
COMMENT ON COLUMN material_blocks.url IS
    'video — ссылка на YouTube/VK/Rutube (своё видео не храним); image/file/audio — файл в R2';

-- Переносим то, что уже успели завести: один старый материал → один блок.
INSERT INTO material_blocks (material_id, kind, title, body, url, size_bytes, duration_sec, sort_order)
SELECT m.id,
       CASE WHEN m.kind IN ('text', 'image', 'video', 'file', 'audio') THEN m.kind
            ELSE 'button' END,          -- 'link' старого набора → кнопка
       NULL, m.body, m.url, m.size_bytes, m.duration_sec, 0
  FROM materials m
 WHERE COALESCE(m.url, '') <> '' OR COALESCE(m.body, '') <> '';

-- ⚠️ Старые колонки убираем: два способа задать содержимое — гарантированный
-- источник расхождений.
ALTER TABLE materials
    DROP COLUMN IF EXISTS kind,
    DROP COLUMN IF EXISTS url,
    DROP COLUMN IF EXISTS body,
    DROP COLUMN IF EXISTS duration_sec,
    DROP COLUMN IF EXISTS size_bytes;

-- ⚠️ Роль plusson не владелец таблиц.
GRANT SELECT, INSERT, UPDATE, DELETE ON material_blocks TO plusson;
GRANT USAGE, SELECT ON material_blocks_id_seq TO plusson;

COMMIT;
