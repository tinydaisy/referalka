-- 449: библиотека логотипов бренда — несколько версий знака для организаторов.
--
-- Зачем. У бренда логотип не один: горизонтальный и квадратный, полный знак и
-- только иконка, цветной и монохромный для печати, на прозрачном фоне и на
-- плашке. Организатору под афишу нужен свой вариант, и сейчас он его просто не
-- получает: у клиента ровно два поля (brand_logo_url для тёмного фона и
-- brand_logo_light_url для светлого), остальные версии пересылаются файлами
-- в личке — ровно та работа, ради отмены которой делалась страница /sp/{код}.
--
-- ⚠️ Устроено ТАК ЖЕ, как библиотека фото спикера (client_speaker_photos,
-- мигр. 323), вплоть до имён колонок: у картинок есть жизненный цикл (загрузка
-- в R2, переименование, удаление с чисткой файла, порядок), и в JSONB это
-- неудобно. Одинаковая форма — чтобы не разбираться дважды ни клиенту в
-- кабинете, ни следующей сессии в коде.
--
-- ⚠️ Старые поля clients.brand_logo_url и brand_logo_light_url НЕ трогаем и НЕ
-- переносим: на них завязаны афиши, обложки, шапки страниц, favicon и письма.
-- Библиотека ДОПОЛНЯЕТ их — это витрина для организатора, а не замена
-- рабочему знаку. Галочка is_primary отмечает версию, которую показываем
-- первой.
--
-- ⚠️ Подпись (label) — свободный текст, а не выбор из списка (решение
-- владельца 18.09.2026). Заранее угадать набор версий нельзя: у одного бренда
-- «монохром для печати», у другого «знак без подписи под круглую аватарку».
-- В кабинете рядом с полем стоит подсказка с примерами.

BEGIN;

CREATE TABLE IF NOT EXISTS client_brand_logos (
    id          SERIAL PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    url         TEXT    NOT NULL,
    label       TEXT,
    -- Показывать на ТЁМНОЙ подложке. Светлый знак на белой карточке сливается
    -- с фоном — организатор решит, что файл битый. Отмечает клиент при
    -- загрузке, потому что по самой картинке этого не понять: прозрачный фон
    -- выглядит одинаково и у светлой, и у тёмной версии.
    on_dark     BOOLEAN NOT NULL DEFAULT FALSE,
    is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_brand_logos_client
    ON client_brand_logos (client_id, sort_order, id);

-- Главный логотип — один на клиента.
CREATE UNIQUE INDEX IF NOT EXISTS uq_client_brand_logos_primary
    ON client_brand_logos (client_id) WHERE is_primary;

COMMENT ON TABLE client_brand_logos IS
  'Библиотека логотипов бренда: организатор выбирает и скачивает нужную версию';
COMMENT ON COLUMN client_brand_logos.on_dark IS
  'Показывать на тёмной подложке (светлый знак). Иначе — на белой.';

GRANT SELECT, INSERT, UPDATE, DELETE ON client_brand_logos TO plusson;
GRANT USAGE, SELECT ON SEQUENCE client_brand_logos_id_seq TO plusson;

COMMIT;
