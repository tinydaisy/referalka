-- 510. Реакции спикеров — ПО ЗАПУСКАМ эфира (24.09.2026)
--
-- ЗАЧЕМ. `webinar_speaker_reactions` знала только комнату (`room_id`), но не
-- запуск. Итог: счётчик копил реакции ЗА ВСЕ прогоны сразу — «Начать заново»
-- его не сбрасывал, а в аналитике каждой записи показывались одни и те же
-- суммарные цифры вместо цифр этого эфира.
--
-- ⚠️ Так устроены ВСЕ остальные посессионные данные: `webinar_presence`,
-- `webinar_activity`, `webinar_votes` — у всех есть `session_id`. У реакций
-- его просто забыли, отсюда и расхождение.
--
-- ⚠️ Ключ уникальности расширяем сессией: без этого второй запуск не смог бы
-- завести свою строку для того же спикера — ON CONFLICT прибавлял бы к старой.
--
-- ⚠️ Старые строки остаются с session_id = NULL. Это «до того, как научились
-- считать по запускам»: пультом они больше не показываются (там всегда есть
-- текущая сессия), а в аналитике видны у записей без session_id. Обнулять или
-- удалять их нельзя — это реальные реакции реальных зрителей.

ALTER TABLE webinar_speaker_reactions
    ADD COLUMN IF NOT EXISTS session_id INTEGER
        REFERENCES webinar_sessions(id) ON DELETE CASCADE;

-- Старый ключ (room_id, speaker_id, reaction_key) → с учётом запуска.
ALTER TABLE webinar_speaker_reactions
    DROP CONSTRAINT IF EXISTS webinar_speaker_reactions_room_id_speaker_id_reaction_key_key;

-- ⚠️ UNIQUE INDEX, а не CONSTRAINT: в ключе есть nullable-колонка, и для
-- старых строк (session_id IS NULL) нужен предсказуемый NULLS NOT DISTINCT —
-- иначе они перестали бы конфликтовать между собой и задвоились бы.
CREATE UNIQUE INDEX IF NOT EXISTS webinar_speaker_reactions_uniq
    ON webinar_speaker_reactions (room_id, speaker_id, reaction_key, session_id)
    NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_wsr_session
    ON webinar_speaker_reactions (session_id)
    WHERE session_id IS NOT NULL;

COMMENT ON COLUMN webinar_speaker_reactions.session_id IS
  'Запуск эфира (webinar_sessions.id), к которому относятся реакции. NULL — строки, собранные до перехода на посессионный счёт.';
