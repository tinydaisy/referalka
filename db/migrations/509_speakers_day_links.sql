-- 509. Ссылки на эфир в «Программе дня для спикеров» (23.09.2026)
--
-- ЗАЧЕМ. Спикер получает тайминг дня, но куда заходить — в сообщении не
-- сказано: ссылки приходится искать в переписке или спрашивать у организатора
-- перед самым выходом. Дописываем в конец две ссылки, каждую своей строкой
-- через пустую строку.
--
-- ⚠️ ДВЕ РАЗНЫЕ ссылки, их легко перепутать:
--   {stream_url}        — вебинарная комната (её же видят зрители);
--   {speaker_join_url}  — вход в Zoom для самого спикера, у каждого дня свой.
-- Подстановка {speaker_join_url} для дневных рассылок добавлена в
-- message_builder этой же правкой: раньше он работал только в «вы следующие»,
-- где есть слот спикера, а в «Программе дня» слота нет вовсе.
--
-- ⚠️ ТОЛЬКО шаблоны с НЕТРОНУТЫМ текстом (совпадает с заготовкой слово в
-- слово). Текст, который клиент правил под себя, не трогаем вовсе: дописать
-- туда свои строки — испортить его работу. Таким клиентам ссылки добавит
-- «Сформировать заново» или руками.
--
-- ⚠️ Пустой плейсхолдер убирает свою строку целиком (логика message_builder):
-- у события может не быть Zoom вовсе, и «Зум дня:» без ссылки хуже, чем
-- ничего.
--
-- ОБЪЁМ на момент написания: 1 шаблон (событие 89, текст нетронутый).
--
-- ОТКАТ: _bak_509_speakers_day хранит прежний текст.

BEGIN;

DROP TABLE IF EXISTS _bak_509_speakers_day;
CREATE TABLE _bak_509_speakers_day (
    template_id  INTEGER PRIMARY KEY,
    event_id     INTEGER,
    old_text     TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _bak_509_speakers_day (template_id, event_id, old_text)
SELECT id, event_id, text
  FROM broadcast_templates
 WHERE type = 'speakers_day'
   -- Текст нетронут: ровно заготовка, и ссылок в нём ещё нет.
   AND btrim(text) = btrim(
       E'<b>Программа выступлений на завтра</b>\n\n'
       'Уважаемые спикеры! Напоминаем вам тайминг завтрашнего дня — {day_date}\n\n'
       '{day_program_speakers}');

UPDATE broadcast_templates t
   SET text = t.text
              || E'\n\nВебинарная комната: {stream_url}'
              || E'\n\nЗум дня (для спикеров): {speaker_join_url}',
       updated_at = now()
  FROM _bak_509_speakers_day b
 WHERE t.id = b.template_id;

-- ── Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE bad INTEGER;
BEGIN
    -- У всех тронутых обе ссылки должны появиться ровно по разу.
    SELECT count(*) INTO bad
      FROM broadcast_templates t
      JOIN _bak_509_speakers_day b ON b.template_id = t.id
     WHERE t.text NOT LIKE '%{stream_url}%'
        OR t.text NOT LIKE '%{speaker_join_url}%';
    IF bad > 0 THEN
        RAISE EXCEPTION 'У % шаблонов ссылки не дописались', bad;
    END IF;
END $$;

COMMIT;
