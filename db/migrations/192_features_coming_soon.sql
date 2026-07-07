-- 192: Флаг «Скоро будет» для модулей-аддонов.
--
-- Коллабораторная (collab_hub) ещё в разработке — показываем модуль, но без
-- цены/кнопки покупки, с меткой «Скоро будет» (в кабинете и на лендинге).

ALTER TABLE features
  ADD COLUMN IF NOT EXISTS coming_soon BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE features SET coming_soon = TRUE WHERE slug = 'collab_hub';
