-- Миграция 203: поле «С какими вопросами можно обращаться?» у коллаба (ГЛОБАЛЬНО).
-- Живёт на collaborators (одно значение на все события спикера), отдельно от
-- per-event заметок (event_collaborators.notes).
-- ask_topics — текст (список вопросов/тем эксперта).
-- show_ask_topics_field — показывать ли поле в кабинете спикера.

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS ask_topics TEXT,
  ADD COLUMN IF NOT EXISTS show_ask_topics_field BOOLEAN NOT NULL DEFAULT FALSE;

-- Бэкфилл: у кого хотя бы в одном событии была включена галочка «Показывать
-- заметки» (event_collaborators.show_notes_field=TRUE) — переносим текст заметок
-- в глобальное поле коллаба и включаем show_ask_topics_field. Берём заметки из
-- самого свежего event_collaborators с непустым notes. Сами notes НЕ трём,
-- но per-event show_notes_field снимаем (заметки больше не показываем).
UPDATE collaborators c
   SET ask_topics = sub.notes,
       show_ask_topics_field = TRUE
  FROM (
    SELECT DISTINCT ON (ec.speaker_id) ec.speaker_id, ec.notes
      FROM event_collaborators ec
     WHERE ec.show_notes_field = TRUE
       AND COALESCE(NULLIF(TRIM(ec.notes), ''), NULL) IS NOT NULL
     ORDER BY ec.speaker_id, ec.id DESC
  ) sub
 WHERE c.id = sub.speaker_id;

-- Галочку «Показывать заметки» снимаем везде (заметки заменены новым полем).
UPDATE event_collaborators SET show_notes_field = FALSE WHERE show_notes_field = TRUE;

GRANT SELECT, INSERT, UPDATE, DELETE ON collaborators TO plusson;
