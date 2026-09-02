-- 337: восстановление DDL, который был накачен мимо миграций (2026-09-02)
--
-- Зачем. Сверка кода со схемой прода показала, что часть структуры живёт
-- ТОЛЬКО на проде: её заводили прямым ALTER'ом, а файла миграции не написали.
-- Последствие простое и неприятное: базу с нуля по db/migrations собрать
-- нельзя — код упадёт на несуществующих колонках, а фича не откроется
-- ни одному клиенту. Проверять «накачено ли» тоже нечем.
--
-- Файл ничего не меняет на проде (везде IF NOT EXISTS / ON CONFLICT) —
-- он только приводит репозиторий в соответствие с базой.
--
-- ⚠️ Правило на будущее: колонку или фичу заводим ФАЙЛОМ миграции, даже
-- если правка делается вручную на сервере. Иначе следующий разработчик
-- (и следующая копия базы) о ней не узнает.

-- ── 1. event_participants: три колонки без миграции ───────────────────────
-- is_registered  — «человек зарегистрировался», а не просто открыл событие.
--                  Заменила колонку status, дропнутую миграцией 036.
-- is_in_chat     — «состоит в чате события». Ставится проверкой чатов
--                  (миграция 130 честно писала «существующее поле», но
--                  создающей миграции никогда не было).
-- entry_link     — по какой ссылке человек зашёл.
ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS is_registered BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS is_in_chat    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE event_participants
    ADD COLUMN IF NOT EXISTS entry_link    TEXT;

COMMENT ON COLUMN event_participants.is_registered IS
  'Зарегистрирован на событие (не просто открыл). Переключается и вручную из кабинета.';
COMMENT ON COLUMN event_participants.is_in_chat IS
  'Состоит в чате события. Заполняется кнопкой «Проверить чаты» (пока только Telegram).';

-- ── 2. Фича «Анкеты» ──────────────────────────────────────────────────────
-- backend/app/api/surveys.py требует фичу 'surveys', но ни одна миграция её
-- не заводила: на проде она есть, в репозитории — нет. На чистой базе анкеты
-- не открылись бы вообще ни у кого, включая admin.
INSERT INTO features (slug, name, description, sort)
VALUES ('surveys', 'Анкеты',
        'Свои анкеты с готовой ссылкой: вопросы, ответы в базу контактов, аналитика',
        95)
ON CONFLICT (slug) DO NOTHING;

-- Тарифы те же, что на проде: Экстра и admin.
INSERT INTO tariff_features (tariff_id, feature_id)
SELECT t.id, f.id FROM tariffs t, features f
 WHERE t.slug IN ('vip', 'admin') AND f.slug = 'surveys'
ON CONFLICT DO NOTHING;
