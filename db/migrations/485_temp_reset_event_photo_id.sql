-- 485: ВРЕМЕННО — все спикеры показываются профильным фото из «Профиля»,
-- а не выбранным вариантом из библиотеки «Другие фото для афиш».
--
-- ⚠️⚠️ ЭТО ОБРАТИМАЯ ПРАВКА ПО ПРОСЬБЕ ВЛАДЕЛЬЦА (21.09.2026): «переключи у
-- всех спикеров в разделе „Выступление" их фото с тех что загрузили — на
-- общие из профиля — потом скажу когда вернуть обратно».
--
-- Как устроено. Правило подстановки одно на весь проект
-- (`backend/app/services/event_photo.py`):
--     event_collaborators.photo_id задан → берём фото из библиотеки;
--     не задан                          → collaborators.photo_url (профиль).
-- Значит переключить «на общие из профиля» — это обнулить `photo_id`.
-- Трогать `collaborator_photos` НЕ НАДО: сами загруженные файлы остаются
-- на месте и видны в карточке, меняется только КАКОЙ из них выбран.
--
-- ⚠️ Выбор сохраняется в `event_collaborators_photo_id_backup` — ИМЕННО
-- поэтому возврат возможен. Без резервной копии «вернуть обратно» означало
-- бы обойти всех спикеров руками и вспомнить, у кого что стояло; после
-- сотни спикеров это уже не вспомнить вовсе.
--
-- ВЕРНУТЬ ОБРАТНО (когда владелец скажет) — миграция 486, см. её заголовок.

BEGIN;

-- ⚠️ Таблица-снимок, не постоянная часть схемы: живёт до возврата.
-- `IF NOT EXISTS` + вставка только новых строк — чтобы повторный прогон
-- миграции (а он бывает при переналивке) не затёр снимок пустотой:
-- второй раз photo_id уже NULL, и «свежая» копия записала бы NULL поверх
-- сохранённого выбора, то есть уничтожила бы возможность вернуть.
CREATE TABLE IF NOT EXISTS event_collaborators_photo_id_backup (
    event_collaborator_id INTEGER PRIMARY KEY,
    photo_id              INTEGER NOT NULL,
    saved_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO event_collaborators_photo_id_backup (event_collaborator_id, photo_id)
SELECT ec.id, ec.photo_id
  FROM event_collaborators ec
 WHERE ec.photo_id IS NOT NULL
ON CONFLICT (event_collaborator_id) DO NOTHING;

UPDATE event_collaborators SET photo_id = NULL WHERE photo_id IS NOT NULL;

COMMIT;
