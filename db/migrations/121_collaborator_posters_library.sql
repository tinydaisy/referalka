-- 121_collaborator_posters_library.sql
-- 2026-05-29
--
-- Библиотека афиш коллаборатора (множественные афиши на одного спикера).
--
-- Раньше: одна глобальная афиша `collaborators.poster_url` + одна per-event
-- `event_collaborators.poster_url`. Если клиент хотел разные афиши для разных
-- конференций — приходилось удалять старую перед загрузкой новой.
--
-- Теперь: библиотека `collaborator_posters` на уровне коллаба (множество афиш)
-- + FK `event_collaborators.poster_id` указывает какая из библиотеки используется
-- в этой конференции (для рассылок, автопостов, виджетов).
--
-- В кабинете спикера (/speaker/<slug>) видна вся библиотека — спикер может
-- скачать любую афишу. В Mini App / рассылках / лендинг-виджете — fallback:
-- cse.poster_id → если NULL, первая из библиотеки коллаба.
--
-- Старые поля `collaborators.poster_url` и `event_collaborators.poster_url`
-- мигрируются в новую таблицу и дропаются — никакой dual-write.

BEGIN;

CREATE TABLE collaborator_posters (
  id              SERIAL PRIMARY KEY,
  collaborator_id INT NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  label           TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_collaborator_posters_coll
  ON collaborator_posters(collaborator_id, sort_order, id);

ALTER TABLE event_collaborators
  ADD COLUMN poster_id INT NULL REFERENCES collaborator_posters(id) ON DELETE SET NULL;

-- 1. Глобальные афиши → библиотека (sort_order=0, эта будет default-fallback).
INSERT INTO collaborator_posters (collaborator_id, url, sort_order, created_at)
SELECT id, TRIM(poster_url), 0, COALESCE(updated_at, created_at, NOW())
  FROM collaborators
 WHERE poster_url IS NOT NULL AND TRIM(poster_url) <> '';

-- 2. Per-event афиши → библиотека (только если URL ещё нет у коллаба).
INSERT INTO collaborator_posters (collaborator_id, url, sort_order)
SELECT DISTINCT ec.speaker_id, TRIM(ec.poster_url), 1
  FROM event_collaborators ec
 WHERE ec.poster_url IS NOT NULL AND TRIM(ec.poster_url) <> ''
   AND NOT EXISTS (
     SELECT 1 FROM collaborator_posters cp
      WHERE cp.collaborator_id = ec.speaker_id
        AND cp.url = TRIM(ec.poster_url)
   );

-- 3. Проставляем poster_id в event_collaborators (FK на запись из библиотеки).
UPDATE event_collaborators ec
   SET poster_id = cp.id
  FROM collaborator_posters cp
 WHERE cp.collaborator_id = ec.speaker_id
   AND cp.url = TRIM(ec.poster_url)
   AND ec.poster_url IS NOT NULL
   AND TRIM(ec.poster_url) <> '';

-- 4. Дропаем старые поля.
ALTER TABLE collaborators       DROP COLUMN poster_url;
ALTER TABLE event_collaborators DROP COLUMN poster_url;

COMMIT;
