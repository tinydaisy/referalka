-- 452: сдвиг кадра внутри маски — вверх-вниз и влево-вправо.
--
-- ⚠️ ЗАЧЕМ. Отмеченная точка лица встаёт РОВНО в центр маски (так теперь
-- считает вёрстка). Но иногда центр — не то, что нужно: у человека в шляпе
-- хочется опустить кадр, чтобы вошли поля, а у высокой причёски — поднять.
-- Зум этого не решает: он приближает, не двигая.
--
-- Значения в ПРОЦЕНТАХ размера маски: -50 сдвигает на пол-маски влево/вверх,
-- +50 — вправо/вниз. 0 — точка ровно в центре.
--
-- ⚠️ Своё у каждой формы, как и зум: в круге и квадрате видно разное, и один
-- общий сдвиг подошёл бы в лучшем случае одной форме.

BEGIN;

ALTER TABLE collaborators
  ADD COLUMN IF NOT EXISTS crop_dx_circle NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (crop_dx_circle BETWEEN -50 AND 50),
  ADD COLUMN IF NOT EXISTS crop_dy_circle NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (crop_dy_circle BETWEEN -50 AND 50),
  ADD COLUMN IF NOT EXISTS crop_dx_square NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (crop_dx_square BETWEEN -50 AND 50),
  ADD COLUMN IF NOT EXISTS crop_dy_square NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (crop_dy_square BETWEEN -50 AND 50),
  ADD COLUMN IF NOT EXISTS crop_dx_portrait NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (crop_dx_portrait BETWEEN -50 AND 50),
  ADD COLUMN IF NOT EXISTS crop_dy_portrait NUMERIC(5,1) NOT NULL DEFAULT 0
      CHECK (crop_dy_portrait BETWEEN -50 AND 50);

COMMENT ON COLUMN collaborators.crop_dx_circle IS
  'Сдвиг кадра в круге по горизонтали, % размера маски (0 — точка лица в центре)';
COMMENT ON COLUMN collaborators.crop_dy_circle IS
  'Сдвиг кадра в круге по вертикали, % размера маски';

GRANT SELECT, INSERT, UPDATE, DELETE ON collaborators TO plusson;

COMMIT;
