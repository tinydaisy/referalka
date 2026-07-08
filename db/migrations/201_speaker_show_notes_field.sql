-- Миграция 201: тоггл «Заметки — спикер может заполнить сам»
-- Организатор в дашборде включает галочку → спикер видит поле «Заметки»
-- в своём кабинете и может сохранить текст в event_collaborators.notes.
-- Default FALSE (opt-in, как show_knowledge_base_field).

ALTER TABLE event_collaborators
  ADD COLUMN IF NOT EXISTS show_notes_field BOOLEAN NOT NULL DEFAULT FALSE;
