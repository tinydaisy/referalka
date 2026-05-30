-- 124_speaker_announcement_tracker.sql
-- 2026-05-30
--
-- Трекер анонсов спикеров — отдельная вкладка в карточке конференции/турнира/премии.
--
-- Матрица: строки = коллабораторы события (спикеры/хедлайнеры/жюри/партнёры,
-- организаторы внизу), колонки = «Анонс 1/2/3…» × площадки (ТГ/Инст/ВК/МАХ/
-- Ютюб/Емейл/Чат-бот, настраиваются клиентом). В ячейке — чекбокс «сделано»
-- (по умолчанию выкл) + свободный текст. Слева отдельная колонка «Договорённости»
-- (свободный текст на спикера).
--
-- Информация рыхлая (у каждого свой текст, площадки у разных событий разные),
-- поэтому всё хранится текстом, а колонки-площадки и колонки-анонсы —
-- настраиваемые per-event.
--
-- Ячейки и договорённости ключуются по collaborator_id (глобальный коллаб),
-- а НЕ по event_collaborators.id — чтобы при удалении спикера из события
-- (и обратном добавлении) текст не терялся.

BEGIN;

-- Колонки-площадки события (ТГ, Инст, ВК, ...). Своя на каждое событие.
CREATE TABLE event_announcement_platforms (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_ann_platforms_event
  ON event_announcement_platforms(event_id, sort_order, id);

-- Колонки-анонсы события («Анонс 1», «Анонс 2», ...). По умолчанию 3.
CREATE TABLE event_announcement_columns (
  id          SERIAL PRIMARY KEY,
  event_id    INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_ann_columns_event
  ON event_announcement_columns(event_id, sort_order, id);

-- Ячейка матрицы: спикер × анонс × площадка. Чекбокс + текст.
CREATE TABLE speaker_announcement_cells (
  id              SERIAL PRIMARY KEY,
  event_id        INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  collaborator_id INT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  column_id       INT NOT NULL REFERENCES event_announcement_columns(id) ON DELETE CASCADE,
  platform_id     INT NOT NULL REFERENCES event_announcement_platforms(id) ON DELETE CASCADE,
  is_done         BOOLEAN NOT NULL DEFAULT FALSE,
  content         TEXT NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (column_id, platform_id, collaborator_id)
);
CREATE INDEX idx_speaker_ann_cells_event
  ON speaker_announcement_cells(event_id);

-- Левая колонка «Договорённости»: один текст на спикера в событии.
CREATE TABLE speaker_announcement_agreements (
  id              SERIAL PRIMARY KEY,
  event_id        INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  collaborator_id INT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  content         TEXT NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, collaborator_id)
);
CREATE INDEX idx_speaker_ann_agreements_event
  ON speaker_announcement_agreements(event_id);

-- Гранты для роли приложения (на dev/проде роль = plusson, не postgres).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  event_announcement_platforms,
  event_announcement_columns,
  speaker_announcement_cells,
  speaker_announcement_agreements
  TO plusson;
GRANT USAGE, SELECT ON
  event_announcement_platforms_id_seq,
  event_announcement_columns_id_seq,
  speaker_announcement_cells_id_seq,
  speaker_announcement_agreements_id_seq
  TO plusson;

COMMIT;
