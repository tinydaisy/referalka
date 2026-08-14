-- Как показывать картинку в карточке блока: обрезать или вписать (2026-08-14).
--
-- Зачем. Картинка в карточке рисовалась только `object-cover` — обрезалась по
-- краям. На скриншотах-доказательствах главное как раз по краям: цифры
-- («2976 получателей», «21 244 подписчика»), и обрезка их срезала.
--
-- ⚠️ Дефолт NULL = «вписать» (contain). Обрезка остаётся выбором клиента —
-- для портретов и обложек она уместнее.
ALTER TABLE event_landing_blocks
    ADD COLUMN IF NOT EXISTS card_img_fit TEXT;
ALTER TABLE event_landing_blocks
    DROP CONSTRAINT IF EXISTS event_landing_blocks_card_img_fit_chk;
ALTER TABLE event_landing_blocks
    ADD CONSTRAINT event_landing_blocks_card_img_fit_chk
    CHECK (card_img_fit IS NULL OR card_img_fit IN ('crop', 'fit'));
