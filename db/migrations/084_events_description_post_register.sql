-- Миграция 084: разделить описание события на два независимых текста.
--
-- Раньше events.description показывался везде: на лендинге и в Mini App
-- внутри вкладки «Программа». Клиенты хотят разные тексты: на лендинге
-- — продающее описание, после регистрации — инструкции «что делать дальше»
-- (со ссылками на голосование/стрим/чат).
--
-- Новое поле:
--   events.description_post_register — текст, показываемый в Mini App
--   на вкладке «Программа» ПОД плитками (стрим/голосование + чат).
--
-- Старое поле events.description остаётся «текстом на лендинг».
--
-- Для существующих событий копируем текущее description в новое поле один раз —
-- чтобы Mini App продолжал показывать тот же текст в программе сразу после
-- миграции, без правки руками. Дальше клиент может редактировать оба
-- независимо.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS description_post_register TEXT;

UPDATE events
   SET description_post_register = description
 WHERE description_post_register IS NULL
   AND description IS NOT NULL
   AND description <> '';
