-- 320: своё файловое хранилище клиента (S3-совместимое, напр. Cloud.ru)
--
-- Зачем. Встроенного места хватает надолго для афиш и фото, но одна запись
-- эфира — это гигабайты. Клиент подключает своё бесплатное хранилище (Cloud.ru
-- даёт 15 ГБ и 10 ТБ трафика в месяц), и вопрос места закрывается.
--
-- ⚠️ Ключи вводит САМ КЛИЕНТ в кабинете, а не присылает в поддержку: пересылка
-- секретного ключа перепиской — это утечка, он даёт полный доступ к хранилищу.
--
-- ⚠️ storage_public_url — адрес, по которому файлы отдаются посетителям. У
-- Cloud.ru он собирается из ГЛОБАЛЬНОГО имени бакета, а не из обычного:
-- https://global.s3.cloud.ru/<глобальное_имя>. Без него картинки не открываются.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS storage_provider   TEXT,           -- NULL = наше хранилище
  ADD COLUMN IF NOT EXISTS storage_endpoint   TEXT,           -- https://s3.cloud.ru
  ADD COLUMN IF NOT EXISTS storage_region     TEXT,           -- ru-central-1
  ADD COLUMN IF NOT EXISTS storage_bucket     TEXT,           -- pluson
  ADD COLUMN IF NOT EXISTS storage_access_key TEXT,
  ADD COLUMN IF NOT EXISTS storage_secret_key TEXT,
  ADD COLUMN IF NOT EXISTS storage_public_url TEXT,           -- https://global.s3.cloud.ru/<глобальное_имя>
  ADD COLUMN IF NOT EXISTS storage_checked_at TIMESTAMPTZ,    -- когда связь проверялась
  ADD COLUMN IF NOT EXISTS storage_error      TEXT;           -- последняя ошибка проверки

-- Провайдер задаётся кодом, а не CHECK-ом: добавление второго облака не должно
-- требовать миграции (тот же приём, что у block_button/title_align).
COMMENT ON COLUMN clients.storage_provider IS
  'NULL = хранилище ПЛЮСОНа. Иначе код провайдера, напр. cloudru';
