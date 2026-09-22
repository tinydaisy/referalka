-- 492. Афиши спикера: ориентация — ПОЛЕМ, и по одной на тип в карточке события
--
-- Было: `collaborator_posters` — общая библиотека коллаба, куча афиш без
-- структуры, а ориентация закодирована СТРОКОЙ в `label` вида
-- «iViSiON-9: ТВОЙ РЫЧАГ (square)». Отсюда всё кривое поведение:
--   • у 66 из 96 афиш прода `label` пуст — ориентацию не определить вовсе;
--   • привязка к событию тоже живёт в тексте (`event_photo.poster_subquery`
--     сравнивает начало label с названием события) — переименовали событие,
--     и афиши «отвязались»;
--   • на одного спикера копятся десятки афиш разных конференций, выбрать из
--     них нужную можно только глазами.
--
-- Стало (решение владельца 22.09.2026): у спикера НА КАЖДОЕ СОБЫТИЕ ровно три
-- слота — горизонтальный, квадратный, вертикальный. Как вкладки чатов
-- TG/ВК/MAX: три вкладки, в каждую грузится одна картинка.
--
-- ⚠️ Таблица НОВАЯ, а не ALTER старой. `collaborator_posters` остаётся как
-- есть: на неё завязаны `event_collaborators.poster_id`,
-- `announcement_poster_ids`, ZIP-выгрузка и кабинет спикера. Снести её одним
-- махом значило бы уронить всё это разом; переводим потребителей по одному,
-- а старая библиотека доживает как источник для миграции данных.

CREATE TABLE IF NOT EXISTS event_speaker_posters (
    id              SERIAL PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    -- Спикер события (event_collaborators), а не коллаб: у одного человека
    -- на разных конференциях афиши разные.
    ec_id           INTEGER NOT NULL REFERENCES event_collaborators(id) ON DELETE CASCADE,
    orientation     TEXT NOT NULL CHECK (orientation IN ('horizontal', 'square', 'vertical')),
    url             TEXT NOT NULL,
    -- Кто положил: 'generator' — сборка генератором афиш, 'manual' — загрузка
    -- руками в карточке спикера. Нужен, чтобы пересборка генератором не
    -- затирала молча то, что клиент загрузил сам.
    source          TEXT NOT NULL DEFAULT 'manual',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- ⚠️ ПО ОДНОЙ НА ТИП — это и есть суть задачи. Вторая афиша той же
    -- ориентации не добавляется, а ЗАМЕНЯЕТ первую (ON CONFLICT DO UPDATE).
    UNIQUE (ec_id, orientation)
);

CREATE INDEX IF NOT EXISTS idx_esp_event ON event_speaker_posters (event_id);
CREATE INDEX IF NOT EXISTS idx_esp_ec    ON event_speaker_posters (ec_id, orientation);

GRANT SELECT, INSERT, UPDATE, DELETE ON event_speaker_posters TO plusson;
GRANT USAGE, SELECT ON SEQUENCE event_speaker_posters_id_seq TO plusson;

-- ── Перенос того, что можно определить надёжно ────────────────────────────
-- Берём афиши, у которых ориентация явно написана в label, и чьё событие
-- совпадает по названию (та же логика, что в `poster_subquery`). Остальные
-- (66 безымянных) НЕ трогаем: гадать ориентацию по картинке нельзя, а
-- поставить наугад — значит подсунуть в рассылку вертикальную вместо
-- квадратной. Они остаются в старой библиотеке, клиент перезальёт нужное.
--
-- ⚠️ DISTINCT ON — если у спикера в библиотеке несколько афиш одной
-- ориентации для одного события, берём САМУЮ СВЕЖУЮ (по id): генератор при
-- пересборке добавлял новую, не удаляя старую.
INSERT INTO event_speaker_posters (event_id, ec_id, orientation, url, source, created_at)
SELECT DISTINCT ON (ec.id, o.orientation)
       ec.event_id, ec.id, o.orientation, cp.url, 'generator', cp.created_at
  FROM collaborator_posters cp
  -- ⚠️ `event_collaborators.speaker_id` ссылается на `collaborators.id`
  -- (таблица спикеров называется collaborators, а поле — speaker_id).
  JOIN collaborators c        ON c.id = cp.collaborator_id
  JOIN event_collaborators ec ON ec.speaker_id = c.id
  JOIN events e               ON e.id = ec.event_id
  CROSS JOIN LATERAL (VALUES ('horizontal'), ('square'), ('vertical')) AS o(orientation)
 WHERE cp.label IS NOT NULL
   AND cp.label <> ''
   AND cp.label ILIKE '%(' || o.orientation || ')'
   AND cp.label ILIKE e.title || ' (%'
 ORDER BY ec.id, o.orientation, cp.id DESC
ON CONFLICT (ec_id, orientation) DO NOTHING;
