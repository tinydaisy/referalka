-- Миграция 078: кеш Telegram file_id для медиа в шаблоне воронки.
--
-- При первой отправке sendPhoto/sendVideo с url-payload Telegram скачивает файл
-- с нашего R2 себе на серверы и в ответе возвращает file_id. На последующих
-- отправках можно слать file_id вместо url — Telegram отдаст из своего кеша
-- мгновенно, без обращения к R2.
--
-- При замене медиа в шаблоне (новый url) file_id сбрасывается в NULL — после
-- первой отправки нового файла он будет заполнен снова.

ALTER TABLE funnel_templates
    ADD COLUMN IF NOT EXISTS text_1_media_file_id TEXT,
    ADD COLUMN IF NOT EXISTS text_2_media_file_id TEXT;
