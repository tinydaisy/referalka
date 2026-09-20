-- Блок «Партнёры» на лендинге: какой логотип брать у партнёра-компании и
-- какой фон рисовать под ним.
--
-- ⚠️ У карточки партнёра-компании ДВА логотипа: основной (`photo_url`) и
-- «для светлого фона» (`logo_on_light_url`, заполняется в разделе «Люди»).
-- Лендинг знал только первый — а он часто светлый, и на белой плашке
-- пропадал. Выбор — НА УРОВНЕ СЕКЦИИ, а не у каждого партнёра: у всех
-- логотипов в блоке один и тот же фон, значит и версия нужна одна.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS partner_logo_variant text;

-- Фон поля под логотипом. NULL = прежний белый (у собранных лендингов вид не
-- меняется сам по себе). Особое значение 'none' — БЕЗ фона: логотипы с
-- прозрачностью ложатся прямо на карточку, и белая плашка не выглядит
-- заплаткой.
ALTER TABLE event_landing_blocks
  ADD COLUMN IF NOT EXISTS logo_bg text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'event_landing_blocks_partner_logo_variant_chk') THEN
    ALTER TABLE event_landing_blocks
      ADD CONSTRAINT event_landing_blocks_partner_logo_variant_chk
      CHECK (partner_logo_variant IS NULL
             OR partner_logo_variant IN ('main', 'light'));
  END IF;
END $$;
