-- 477: три источника картинки спикера в шаблонах рассылок.
--
-- ⚠️⚠️ ЗАЧЕМ. Вариантов было два: 'poster' (готовая афиша) и 'photo'. Но
-- «просто фото» стало двусмысленным после миграции 472: под событие можно
-- загрузить СВОЙ снимок (карикатуру, фото с предметом), и выбрать именно
-- профильный — тот, что загрузил сам спикер, — было нельзя вовсе.
--
-- Теперь источника три:
--   poster        — собранная афиша спикера из его библиотеки;
--   photo_profile — снимок, загруженный САМИМ СПИКЕРОМ в профиль;
--   photo_event   — фото, подготовленное клиентом ПОД ЭТО СОБЫТИЕ (мигр. 472).
--
-- ⚠️ Старое значение 'photo' ОСТАВЛЯЕМ разрешённым и НЕ переписываем. Оно и
-- раньше отдавало фото события, когда оно было (через COALESCE), — то есть
-- ведёт себя как photo_event. Переписав его, мы бы молча поменяли поведение
-- уже настроенных шаблонов; вместо этого интерфейс показывает такие шаблоны
-- как «Фото для этого события», а код трактует 'photo' так же.

BEGIN;

ALTER TABLE broadcast_templates
  DROP CONSTRAINT IF EXISTS broadcast_templates_speaker_photo_mode_check;
ALTER TABLE broadcast_templates
  ADD CONSTRAINT broadcast_templates_speaker_photo_mode_check
  CHECK (speaker_photo_mode IN ('poster', 'photo', 'photo_profile', 'photo_event'));

COMMENT ON COLUMN broadcast_templates.speaker_photo_mode IS
  'Откуда брать картинку спикера: poster — готовая афиша, '
  'photo_profile — фото из профиля спикера, photo_event — фото под это '
  'событие. Устаревшее photo = photo_event (оставлено для старых шаблонов)';

GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_templates TO plusson;

COMMIT;

-- ── Блок тем на афише спикера ────────────────────────────────────────────
--
-- ⚠️ Дата и тема красятся РАЗНЫМИ цветами («29.09 в 11:00:» одним, название
-- другим) — так просил владелец. Поэтому у даты свой цвет, а не общий с темой.
BEGIN;

ALTER TABLE event_poster_layouts
  ADD COLUMN IF NOT EXISTS ind_topic_when_color TEXT,
  -- Показывать ли дату перед темой вообще: на афише с одним выступлением она
  -- дублирует пилюлю.
  ADD COLUMN IF NOT EXISTS ind_topic_show_when BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN event_poster_layouts.ind_topic_when_color IS
  'Цвет даты и времени перед темой («29.09 в 11:00:»). NULL — брендовый акцент';

GRANT SELECT, INSERT, UPDATE, DELETE ON event_poster_layouts TO plusson;

COMMIT;
