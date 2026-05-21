-- Миграция 092: убрать дубль описания.
--
-- До 084 описание события жило в двух местах:
--   events.description — для базовых событий и конкурсов (module_slug='base','contest')
--   conf_conferences.description — для конференций и турниров (module_slug='conference','turnir')
--
-- После 084 в events появился ещё description_post_register (текст для
-- вкладки «Программа» после регистрации), а events.description стал
-- «описанием для лендинга». Для конференций/турниров UI продолжал писать
-- лендинговое описание в conf_conferences.description, которое Mini App
-- не читает — отсюда баг «на лендинге показывается старое описание».
--
-- Делаем events.description единым источником истины для всех типов
-- событий. conf_conferences.description удаляем.
--
-- Перенос данных: если у конференции/турнира есть непустой
-- conf_conferences.description — копируем его в events.description.
-- Перетираем events.description даже если оно непустое, потому что для
-- конференций/турниров оно либо legacy-копия миграции 084 (одинаковое с
-- description_post_register), либо вообще не редактировалось через UI
-- (поле «Описание для лендинга» в дашборде писало в conf-таблицу).
-- Конференц-таблицы для мероприятий и конкурсов отсутствуют — их
-- events.description не пострадает.

UPDATE events e
   SET description = cc.description
  FROM conf_conferences cc
 WHERE cc.event_id = e.id
   AND cc.description IS NOT NULL
   AND cc.description <> '';

ALTER TABLE conf_conferences DROP COLUMN IF EXISTS description;
