-- 507. Чужая афиша в шаблонах рассылок (23.09.2026)
--
-- ЗАЧЕМ. Копирование события переносило `broadcast_templates.photo_url` как
-- есть — вместе с путём афиши ОРИГИНАЛА. Рассылка «День конференции (итоги дня
-- + подарки)» у событий 14 и 89 уходила с афишей события 4: в кабинете у
-- события своя афиша, а в письме чужая, и понять откуда — невозможно.
-- Источник починен в events.py (copy_event); эта миграция чинит уже созданные.
--
-- ⚠️⚠️ ЧУЖУЮ АФИШУ ОПОЗНАЁМ ПО ПУТИ (`posters/event_4/…`), а не по совпадению
-- с записью в `event_posters`. Совпадения нет вовсе: афишу события 4 с тех пор
-- заменили, старый файл из таблицы исчез, а ссылка в шаблоне осталась. Проверка
-- «есть ли такой url у другого события» не нашла бы ни одной строки.
--
-- ⚠️ Меняем только те ссылки, где в пути стоит номер ЧУЖОГО события. Картинку,
-- загруженную в шаблон руками (путь без `event_N`), не трогаем: это осознанный
-- выбор клиента, и подменять его нашей догадкой нельзя. Из 12 шаблонов с фото
-- номер события в пути есть у трёх — два чужих и один свой.
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
   -- В пути есть номер события…
   AND t.photo_url ~ 'event[_/][0-9]+'
   -- …и это НЕ номер своего события.
   AND t.photo_url !~ ('event[_/]' || t.event_id || '(/|_|$)');

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
       AND t.photo_url ~ 'event[_/][0-9]+'
       AND t.photo_url !~ ('event[_/]' || t.event_id || '(/|_|$)');
    IF left_cnt <> 0 THEN
        RAISE EXCEPTION 'Остались шаблоны с чужой афишей: %', left_cnt;
    END IF;
END $$;

COMMIT;
