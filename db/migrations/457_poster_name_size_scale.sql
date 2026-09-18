-- 457: размер имени на афише — доля КАРТОЧКИ, а не процент ширины афиши.
--
-- ⚠️⚠️ ЗАЧЕМ. Настройка называлась «Размер, % ширины афиши» и не работала:
-- в коде значение резалось потолком `cardW * 0.19`. При карточке 8 % потолок
-- равен 1.52, а умолчание было 1.6 — ползунок упирался в него сразу, и ВСЯ
-- ВЕРХНЯЯ ПОЛОВИНА ШКАЛЫ ничего не меняла. Клиент двигал ручку и не видел
-- реакции (жалоба владельца 18.09.2026).
--
-- Сама привязка к ширине АФИШИ была неверной по смыслу: подпись живёт внутри
-- карточки спикера, и её размер логично мерить долей карточки. Тогда при
-- смене числа спикеров подпись масштабируется вместе с фото сама.
--
-- Новый диапазон 5..40 (% ширины карточки), умолчание 15.
--
-- ⚠️ Старые значения ПЕРЕСЧИТЫВАЕМ: 1.6 % афиши при типовой карточке ≈ 20 %
-- карточки. Без пересчёта сохранённые макеты получили бы подпись в десять раз
-- мельче — формально валидную, визуально пропавшую.

BEGIN;

ALTER TABLE event_poster_layouts
  DROP CONSTRAINT IF EXISTS event_poster_layouts_name_size_check;

-- Пересчёт: было в % ширины афиши, стало в % ширины карточки.
-- Коэффициент 12 — отношение типовой карточки (≈8 % афиши) к 100 %.
UPDATE event_poster_layouts
   SET name_size = LEAST(40, GREATEST(5, ROUND(name_size * 12)))
 WHERE name_size <= 8;

ALTER TABLE event_poster_layouts
  ALTER COLUMN name_size SET DEFAULT 15,
  ADD CONSTRAINT event_poster_layouts_name_size_check
      CHECK (name_size BETWEEN 5 AND 40);

COMMENT ON COLUMN event_poster_layouts.name_size IS
  'Размер подписи — % ШИРИНЫ КАРТОЧКИ спикера (не афиши). Длинные фамилии ужимаются автоматически';

-- ⚠️ Линия спикеров на ГОРИЗОНТАЛЬНОЙ афише: у уже сохранённых макетов она
-- осталась около 40 %, и спикерам доставалась треть высоты — карточки и
-- плашка роли выходили мелкими, верхний ряд подрезался. Умолчание для новых
-- макетов уже 28 %; подтягиваем и сохранённые, но только те, где клиент не
-- задавал её осознанно НИЖЕ (такие оставляем как есть).
UPDATE event_poster_layouts
   SET speakers_top = 28
 WHERE orientation = 'horizontal' AND speakers_top BETWEEN 33 AND 50;

-- ⚠️⚠️ КЕГЛИ ТЕКСТА — ТЕПЕРЬ В ПИКСЕЛЯХ, а не в % высоты листа. Проценты
-- давали разброс: одно значение 2.6 превращалось в 42 px на горизонтальной
-- афише и 75 px на вертикальной. Подобрать нормальный размер было нельзя —
-- «то слишком большой, то слишком маленький» (владелец, 18.09.2026).
-- Каждый формат настраивается отдельно, так что пиксели здесь честнее.
--
-- Пересчёт: значение было долей ВЫСОТЫ листа, берём высоту по ориентации.
ALTER TABLE event_poster_layouts
  DROP CONSTRAINT IF EXISTS event_poster_layouts_title_size_check,
  DROP CONSTRAINT IF EXISTS event_poster_layouts_subtitle_size_check,
  DROP CONSTRAINT IF EXISTS event_poster_layouts_pill_size_check;

UPDATE event_poster_layouts
   SET title_size    = LEAST(200, GREATEST(20, ROUND(title_size    * h / 100))),
       subtitle_size = LEAST(90,  GREATEST(10, ROUND(subtitle_size * h / 100))),
       pill_size     = LEAST(70,  GREATEST(8,  ROUND(pill_size     * h / 100)))
  FROM (SELECT id AS lid,
               CASE orientation WHEN 'horizontal' THEN 1080
                                WHEN 'vertical'   THEN 1920
                                ELSE 1440 END AS h
          FROM event_poster_layouts) t
 WHERE event_poster_layouts.id = t.lid
   -- Только ещё не пересчитанные: у процентов значения заведомо мелкие.
   AND title_size <= 20;

ALTER TABLE event_poster_layouts
  ALTER COLUMN title_size    SET DEFAULT 76,
  ALTER COLUMN subtitle_size SET DEFAULT 28,
  ALTER COLUMN pill_size     SET DEFAULT 22,
  ADD CONSTRAINT event_poster_layouts_title_size_check
      CHECK (title_size BETWEEN 20 AND 200),
  ADD CONSTRAINT event_poster_layouts_subtitle_size_check
      CHECK (subtitle_size BETWEEN 10 AND 90),
  ADD CONSTRAINT event_poster_layouts_pill_size_check
      CHECK (pill_size BETWEEN 8 AND 70);

COMMENT ON COLUMN event_poster_layouts.title_size IS
  'Кегль заголовка в ПИКСЕЛЯХ полотна (в готовом файле ×1.5)';

COMMIT;
