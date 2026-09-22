-- 491. Участники события: дата прихода и дата последнего действия
--
-- На вкладке «Участники» сортировка была `registered_at DESC`, а у
-- НЕЗАРЕГИСТРИРОВАННЫХ это поле пустое (на событии 89 таких 50 из 157). NULL
-- в PostgreSQL при DESC идёт первым, поэтому полсотни людей без регистрации
-- оказывались наверху, а свежие регистрации — под ними: со стороны выглядело
-- так, будто «люди перестали регистрироваться и что-то сломалось». На деле
-- регистрации шли (последняя — в тот же день).
--
-- Проблема глубже сортировки: даты ПРИХОДА в участники не хранилось вовсе —
-- только `registered_at` (момент регистрации) и `link_clicked_at`. То есть
-- ответить «когда этот человек появился» было нечем.
--
-- Добавляем два поля:
--   joined_at      — когда человек попал в участники (клик по ссылке, заход
--                    в бота, импорт). Ставится один раз и не меняется.
--   last_action_at — последнее действие: приход, клик, регистрация. По нему и
--                    сортируем список, чтобы наверху были те, кто шевелился
--                    последним, независимо от того, дошёл ли до регистрации.
--
-- ⚠️ Существующим строкам проставляем ЛУЧШЕЕ ИЗ ИЗВЕСТНОГО, а не NOW():
-- registered_at → link_clicked_at → NULL. Поставить всем «сейчас» значило бы
-- сообщить, что 157 человек пришли одновременно в момент миграции.

ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS joined_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ;

-- Бэкофилл по уже известным отметкам.
UPDATE event_participants
   SET joined_at = COALESCE(joined_at, registered_at, link_clicked_at)
 WHERE joined_at IS NULL
   AND (registered_at IS NOT NULL OR link_clicked_at IS NOT NULL);

UPDATE event_participants
   SET last_action_at = COALESCE(
         last_action_at,
         GREATEST(
           COALESCE(registered_at,    TIMESTAMPTZ '-infinity'),
           COALESCE(link_clicked_at,  TIMESTAMPTZ '-infinity'),
           COALESCE(joined_at,        TIMESTAMPTZ '-infinity')
         ))
 WHERE last_action_at IS NULL
   AND (registered_at IS NOT NULL OR link_clicked_at IS NOT NULL OR joined_at IS NOT NULL);

-- GREATEST выше мог дать '-infinity', если все три пусты — чистим.
UPDATE event_participants
   SET last_action_at = NULL
 WHERE last_action_at = TIMESTAMPTZ '-infinity';

-- Новым строкам дату прихода ставит код (`upsert_event_participant`), но
-- DEFAULT страхует пути вставки, которые про поле ещё не знают: пустая дата
-- у только что пришедшего человека — та же болезнь, которую чиним.
ALTER TABLE event_participants
    ALTER COLUMN joined_at      SET DEFAULT NOW(),
    ALTER COLUMN last_action_at SET DEFAULT NOW();

-- Сортировка списка идёт по last_action_at DESC внутри одного события.
CREATE INDEX IF NOT EXISTS idx_event_participants_last_action
    ON event_participants (event_id, last_action_at DESC NULLS LAST);
