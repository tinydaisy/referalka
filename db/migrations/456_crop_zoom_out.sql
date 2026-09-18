-- 456: кадр можно не только приближать, но и ОТДАЛЯТЬ (зум меньше 1).
--
-- ⚠️ ЗАЧЕМ. Диапазон был 1..3 — только увеличение. Но у логотипов задача
-- обратная: вписать знак в круг целиком, а при зуме 1 он уже обрезан по краям
-- (маска берёт cover, то есть заполняет её с запасом). Отдалить было нечем.
--
-- Новый диапазон 0.3..3. Значения меньше 1 оставляют по краям пустоту — для
-- фото человека это плохо, для логотипа наоборот нужно.
--
-- ⚠️ Умолчание остаётся 1.0: у человека кадр должен заполнять маску целиком.

BEGIN;

ALTER TABLE collaborators
  DROP CONSTRAINT IF EXISTS collaborators_crop_zoom_circle_check,
  DROP CONSTRAINT IF EXISTS collaborators_crop_zoom_square_check,
  DROP CONSTRAINT IF EXISTS collaborators_crop_zoom_portrait_check;

ALTER TABLE collaborators
  ADD CONSTRAINT collaborators_crop_zoom_circle_check
      CHECK (crop_zoom_circle BETWEEN 0.3 AND 3),
  ADD CONSTRAINT collaborators_crop_zoom_square_check
      CHECK (crop_zoom_square BETWEEN 0.3 AND 3),
  ADD CONSTRAINT collaborators_crop_zoom_portrait_check
      CHECK (crop_zoom_portrait BETWEEN 0.3 AND 3);

COMMENT ON COLUMN collaborators.crop_zoom_circle IS
  'Кадр в КРУГЛОЙ маске: 1.0 — как есть, меньше 1 — отдалить (вписать логотип), больше — приблизить';

COMMIT;
