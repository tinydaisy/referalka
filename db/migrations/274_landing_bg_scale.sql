-- 274: Масштаб фоновой картинки — отдельно для десктопа и телефона.
--
-- ⚠️ Дополняет миграцию 273 (точка фокуса). Одного фокуса мало: на телефоне
-- кадр обрезается так сильно, что объект приходится не только двигать, но и
-- отдалять — иначе в кадр влезает только его часть (лицо вместо всей фигуры).
--
-- 100 = как есть (object-cover, прежнее поведение). Больше 100 — приближение
-- (объект крупнее, видно меньше кадра), меньше 100 — отдаление (видно больше
-- кадра, по краям появится фон страницы).

ALTER TABLE event_landing_pages
  ADD COLUMN IF NOT EXISTS bg_scale        SMALLINT NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS bg_scale_mobile SMALLINT;  -- NULL → берём bg_scale

GRANT SELECT, INSERT, UPDATE, DELETE ON event_landing_pages TO plusson;
