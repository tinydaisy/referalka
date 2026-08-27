-- 336. Что человек видит в своей форме — настройка НА СОБЫТИИ (2026-08-27)
--
-- Пять тумблеров («Темы», «Подарок после эфира», «Материал в базу знаний»,
-- «Заметки», «Ссылка на регистрацию партнёром») жили только на карточке
-- каждого человека (event_collaborators.show_*). У премии номинантов сотни —
-- выставить одно и то же всем можно было только обойдя все карточки руками.
--
-- Теперь у события есть значения ПО УМОЛЧАНИЮ: они подставляются в момент
-- создания новой карточки. Уже заведённые карточки не трогаются — то, что
-- организатор задал человеку лично, главнее и остаётся как есть.
--
-- ⚠️ Дефолты колонок повторяют прежнее захардкоженное поведение
-- (темы и подарок — да, база знаний и заметки — нет, партнёрка — да),
-- поэтому у существующих событий ничего не меняется.
--
-- ⚠️ У жюри темы и подарок остаются выключенными независимо от этих
-- настроек — это правило роли, а не событийная преференция (см.
-- speaker_defaults.default_show_flags).

ALTER TABLE conf_conferences
  ADD COLUMN IF NOT EXISTS default_show_topic_field              BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS default_show_gift_after_speech_field  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS default_show_knowledge_base_field     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_show_notes_field              BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_show_partner_registration_link BOOLEAN NOT NULL DEFAULT TRUE;
