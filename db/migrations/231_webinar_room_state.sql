-- 231: явное состояние ДОСТУПА к комнате дня, отдельно от факта трансляции.
-- Как в GetCourse: «открыть комнату» и «начать эфир» — разные действия.
--   room_state: created — комната создана, но НЕ открыта: зритель видит афишу +
--                         название + обратный отсчёт до старта, БЕЗ формы входа.
--               open    — комната открыта: зритель может авторизоваться (имя+email)
--                         и попасть внутрь; пока эфир не начат — афиша + «скоро начнётся».
--               closed  — комната закрыта после эфира: «вебинар завершён» + редирект.
-- Трансляция (идёт/нет) по-прежнему в status(live/ended)+stream_active — их можно
-- включать/выключать много раз (новые сессии) внутри room_state='open'.
-- opens_at — планируемое время старта эфира дня для обратного отсчёта на странице.

ALTER TABLE webinar_rooms
  ADD COLUMN IF NOT EXISTS room_state TEXT NOT NULL DEFAULT 'created'
    CHECK (room_state IN ('created', 'open', 'closed')),
  ADD COLUMN IF NOT EXISTS opens_at TIMESTAMPTZ;   -- когда планируется старт (для countdown)

-- Бэкфилл: комнаты, где эфир уже завершался — в closed; остальные — created.
UPDATE webinar_rooms SET room_state = 'closed' WHERE status = 'ended';

GRANT SELECT, INSERT, UPDATE, DELETE ON webinar_rooms TO plusson;
