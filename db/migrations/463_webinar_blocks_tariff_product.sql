-- 463: Два новых продающих блока вебинарной комнаты — тариф события и лендинг продукта.
--
-- Зачем. В комнате уже можно позвать на другое событие (`event_reg`), но нельзя
-- продать то, ради чего эфир и проводится: повышение тарифа на этом же событии
-- и продукт. Клиент выкручивался блоком-кнопкой с ссылкой, набранной руками, —
-- ссылка устаревала молча, а человек об этом узнавал из жалоб зрителей.
--
-- Новые `webinar_blocks.kind`:
--   `tariff_upgrade` — «Повысить тариф»: выбранный тариф ЭТОГО события
--   `product_landing` — «Лендинг продукта»: выбранный продукт клиента
--
-- ⚠️ `kind` в таблице — обычный TEXT без CHECK (миграция 221), поэтому новые
-- значения не требуют правки ограничения. Проверка допустимых видов живёт в
-- коде роутера, где её видно рядом с обработкой.

BEGIN;

ALTER TABLE webinar_blocks
  ADD COLUMN IF NOT EXISTS tariff_id  INTEGER REFERENCES event_tariffs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id)      ON DELETE SET NULL;

COMMENT ON COLUMN webinar_blocks.tariff_id IS
  'kind=tariff_upgrade: какой тариф события предлагаем. ⚠️ ON DELETE SET NULL, а не CASCADE: '
  'удалённый тариф не должен уносить блок вместе с его таймингом и текстом — блок просто '
  'перестаёт показываться, и клиент видит, что нужно выбрать тариф заново';
COMMENT ON COLUMN webinar_blocks.product_id IS
  'kind=product_landing: на лендинг какого продукта ведём. ⚠️ ON DELETE SET NULL по той же причине';

COMMIT;
