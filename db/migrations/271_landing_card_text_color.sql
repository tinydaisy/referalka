-- 271: Свой цвет текста внутри карточек лендинга.
--
-- ⚠️ Зачем. Цвет текста был ОДИН на всю страницу (event_landing_pages.color_body)
-- и применялся и к тексту секций, и к тексту внутри карточек. Из-за этого нельзя
-- собрать частый приём: тёмный фон страницы + СВЕТЛЫЕ карточки (или наоборот).
-- Светлый текст на светлой карточке становился нечитаемым — контраст 1.0.
--
-- NULL = наследовать общий color_body (прежнее поведение, ничего не ломается).
-- Заполнено = этим цветом красится текст ВНУТРИ карточек: описания в блоках
-- «ценности/чем отличаемся», пункты списков, тексты партнёров и тарифов.

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS card_text_color TEXT;  -- NULL → берём color_body

-- Тема клиента (дефолт для НОВЫХ страниц лендинга, миграция 241): держим пару,
-- иначе цвет пришлось бы заново задавать в каждом созданном лендинге.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS lp_card_text_color TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;
GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO plusson;
