-- 508. Закреплять «Программу дня» в чате спикеров (23.09.2026)
--
-- ЗАЧЕМ. Тайминг дня нужен команде ВЕСЬ день, а в живом чате он за час уезжает
-- вверх под обсуждением: спикер листает историю вместо того, чтобы за секунду
-- увидеть свой слот. Закреп держит программу на виду — за этим в чат и заходят.
-- Механизм закрепа (`pin_in_chat`) уже есть и работает во всех трёх площадках,
-- у этого шаблона он просто был выключен.
--
-- ⚠️ ТОЛЬКО `speakers_day`. У «вы следующие» (`speakers_call`) закреп включать
-- НЕЛЬЗЯ: она уходит перед КАЖДЫМ выступлением и перебивала бы закреп по
-- десять раз за день, вытесняя саму программу — то есть ровно то, что нужно
-- держать закреплённым.
--
-- ⚠️ Не трогаем шаблоны, где клиент ВЫКЛЮЧИЛ отправку в чат спикеров
-- (`send_to_speakers_chat = FALSE`): закреплять там нечего, а лишняя правка
-- чужой настройки только путает.
--
-- ОБЪЁМ на момент написания: 1 шаблон (событие 89).
--
-- ОТКАТ: _bak_508_pin хранит id тех, у кого флаг был выключен.

BEGIN;

DROP TABLE IF EXISTS _bak_508_pin;
CREATE TABLE _bak_508_pin (
    template_id  INTEGER PRIMARY KEY,
    event_id     INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _bak_508_pin (template_id, event_id)
SELECT id, event_id
  FROM broadcast_templates
 WHERE type = 'speakers_day'
   AND send_to_speakers_chat = TRUE
   AND COALESCE(pin_in_chat, FALSE) = FALSE;

UPDATE broadcast_templates t
   SET pin_in_chat = TRUE,
       updated_at = now()
  FROM _bak_508_pin b
 WHERE t.id = b.template_id;

-- ── Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE left_cnt INTEGER;
BEGIN
    SELECT count(*) INTO left_cnt
      FROM broadcast_templates
     WHERE type = 'speakers_day'
       AND send_to_speakers_chat = TRUE
       AND COALESCE(pin_in_chat, FALSE) = FALSE;
    IF left_cnt <> 0 THEN
        RAISE EXCEPTION 'Остались шаблоны без закрепа: %', left_cnt;
    END IF;
END $$;

COMMIT;
