-- 507. Чужая афиша в шаблонах рассылок (23.09.2026)
--
-- ЗАЧЕМ. Копирование события переносило `broadcast_templates.photo_url` как
-- есть — вместе с путём афиши ОРИГИНАЛА. Рассылка «День конференции (итоги дня
-- + подарки)» у событий 14 и 89 уходила с афишей события 4: в кабинете у
-- события своя афиша, а в письме чужая, и понять откуда — невозможно.
-- Источник починен в events.py (copy_event); эта миграция чинит уже созданные.
--
-- ⚠️ Меняем ТОЛЬКО ссылку, которая является афишей ДРУГОГО события. Картинку,
-- загруженную в шаблон руками, не трогаем: это осознанный выбор клиента, и
-- подменять её нашей догадкой нельзя.
--
-- ⚠️ Своей афиши у события нет → ставим NULL, а не оставляем чужую. Письмо без
-- картинки честнее письма с афишей постороннего мероприятия.
--
-- ⚠️ Горизонтальная афиша в приоритете — правило проекта (миграция 215):
-- в ленте мессенджера она читается лучше вертикальной.
--
-- ОБЪЁМ на момент написания: 2 шаблона (события 14 и 89, оба с афишей
-- события 4).
--
-- ОТКАТ: _bak_507_tpl_posters хранит прежние ссылки.

BEGIN;

DROP TABLE IF EXISTS _bak_507_tpl_posters;
CREATE TABLE _bak_507_tpl_posters (
    template_id  INTEGER PRIMARY KEY,
    event_id     INTEGER,
    old_photo    TEXT,
    new_photo    TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _bak_507_tpl_posters (template_id, event_id, old_photo, new_photo)
SELECT t.id, t.event_id, t.photo_url,
       (SELECT p.url FROM event_posters p
         WHERE p.event_id = t.event_id AND p.url IS NOT NULL
         ORDER BY (p.orientation = 'horizontal') DESC, p.sort, p.id
         LIMIT 1)
  FROM broadcast_templates t
 WHERE t.photo_url IS NOT NULL
   -- Ссылка — афиша ЧУЖОГО события.
   AND EXISTS (SELECT 1 FROM event_posters p
                WHERE p.url = t.photo_url AND p.event_id <> t.event_id)
   -- И при этом НЕ афиша своего (у события могут быть обе записи).
   AND NOT EXISTS (SELECT 1 FROM event_posters p
                    WHERE p.url = t.photo_url AND p.event_id = t.event_id);

UPDATE broadcast_templates t
   SET photo_url = b.new_photo,
       updated_at = now()
  FROM _bak_507_tpl_posters b
 WHERE t.id = b.template_id;

-- ── Проверка ─────────────────────────────────────────────────────────────
DO $$
DECLARE left_cnt INTEGER;
BEGIN
    SELECT count(*) INTO left_cnt
      FROM broadcast_templates t
     WHERE t.photo_url IS NOT NULL
       AND EXISTS (SELECT 1 FROM event_posters p
                    WHERE p.url = t.photo_url AND p.event_id <> t.event_id)
       AND NOT EXISTS (SELECT 1 FROM event_posters p
                        WHERE p.url = t.photo_url AND p.event_id = t.event_id);
    IF left_cnt <> 0 THEN
        RAISE EXCEPTION 'Остались шаблоны с чужой афишей: %', left_cnt;
    END IF;
END $$;

COMMIT;
