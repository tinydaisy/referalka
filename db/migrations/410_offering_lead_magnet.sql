-- Карточка в «О проекте» может выдавать ЛИД-МАГНИТ, а не вести по ссылке.
--
-- Зачем. В Экосистеме Mini App клиент ведёт карточки «Платно» и «Бесплатно»
-- (`client_offerings`) и указывает у них произвольный адрес `action_url`.
-- Но бесплатные карточки — это по сути те же лид-магниты, и ссылка на них
-- РАЗНАЯ на каждой площадке: у Telegram своя, у ВКонтакте своя, у MAX своя.
-- Одним полем `action_url` это не выразить: человек из MAX уходил по ссылке
-- в Telegram, где у него аккаунта может не быть вовсе.
--
-- ⚠️ `action_url` НЕ УДАЛЯЕТСЯ и остаётся равноправным способом: у карточки
-- бывает и внешний адрес (сайт, оплата, запись). Лид-магнит — второй вариант,
-- а не замена; какой из них используется, видно по заполненности полей.
--
-- ⚠️ ON DELETE SET NULL, а не CASCADE: удаление лид-магнита не должно уносить
-- карточку продукта вместе с её названием, описанием и обложкой. Карточка
-- просто останется без выдачи, и клиент выберет магнит заново.
ALTER TABLE client_offerings
  ADD COLUMN IF NOT EXISTS lead_magnet_id INTEGER
    REFERENCES lead_magnets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS package_id INTEGER
    REFERENCES lead_magnet_packages(id) ON DELETE SET NULL;

-- ⚠️ Магнит ИЛИ пакет, но не оба сразу: иначе непонятно, что выдавать.
-- COALESCE обязателен — без него пара (NULL, 5) даёт NULL, а не FALSE,
-- и проверка такую строку пропустит (на этом уже обжигались в миграции 305).
ALTER TABLE client_offerings
  DROP CONSTRAINT IF EXISTS client_offerings_gift_one_chk;
ALTER TABLE client_offerings
  ADD CONSTRAINT client_offerings_gift_one_chk
  CHECK (COALESCE(lead_magnet_id IS NULL, TRUE) OR COALESCE(package_id IS NULL, TRUE));

CREATE INDEX IF NOT EXISTS idx_client_offerings_lead_magnet
  ON client_offerings(lead_magnet_id) WHERE lead_magnet_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_offerings_package
  ON client_offerings(package_id) WHERE package_id IS NOT NULL;
