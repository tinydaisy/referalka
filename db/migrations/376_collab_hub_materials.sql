-- 376. Наполнение продукта «Коллабораторная ПЛЮСОН (Материалы)» — записи вебинаров.
--
-- ⚠️⚠️ ССЫЛКИ ПЕРЕВЕДЕНЫ С `vkvideo.ru` НА `vk.com/video…`.
-- Плеер (web/src/lib/videoEmbed.ts, embedUrl) собирает embed по шаблону
-- `vk.com/video(-?\d+)_(\d+)` → `vk.com/video_ext.php?oid=…&id=…`. Домен
-- `vkvideo.ru` под этот шаблон НЕ подходит: ссылка вернулась бы как есть и
-- ушла в iframe целой страницей — у ВК она открытие в рамке запрещает, и
-- человек увидел бы пустой чёрный прямоугольник вместо записи. Идентификаторы
-- в обоих доменах одни и те же, поэтому это замена адреса, а не видео.
--
-- ⚠️ Хвост `?list=…` у первой записи срезан: это метка плейлиста, к самому
--    видео отношения не имеет, а в embed мешает.
--
-- ⚠️ `sort_order` кратен 10 — как в tools/getcourse-import: между блоками
--    остаётся место, чтобы вставить забытый, не переписывая остальные.
--
-- ⚠️ HTML в `body` санитайзится при показе (SafeHtml). Разрешены b/i/a/ul/ol/
--    li/p/h2/h3/blockquote/br. h1, img, div, span, table — вырезаются, поэтому
--    их здесь нет.

DO $$
DECLARE
    v_client   INTEGER;
    v_product  INTEGER;
    v_mat      INTEGER;
BEGIN
    SELECT id INTO v_client FROM clients WHERE is_system_service = TRUE LIMIT 1;
    IF v_client IS NULL THEN
        RAISE NOTICE 'Системного клиента нет — наполнять нечего';
        RETURN;
    END IF;

    -- Продукт заведён миграцией 375 уже с этим названием. UPDATE — страховка
    -- для базы, куда 375 приехала в первой редакции (там было просто
    -- «Коллабораторная»): на свежей базе он отработает вхолостую.
    UPDATE products
       SET title = 'Коллабораторная ПЛЮСОН (Материалы)',
           subtitle = 'Записи вебинаров, афиши и тексты для приглашений',
           updated_at = NOW()
     WHERE client_id = v_client AND slug = 'collab-hub';

    SELECT id INTO v_product
      FROM products WHERE client_id = v_client AND slug = 'collab-hub';
    IF v_product IS NULL THEN
        RAISE NOTICE 'Продукта collab-hub нет — сначала миграция 375';
        RETURN;
    END IF;

    -- Повторный прогон не должен плодить копии: материал ищем по названию.
    -- ⚠️ Название материала — ключ идемпотентности, менять его в этой
    --    миграции нельзя (переименование = второй экземпляр).

    -- ── Вебинар 1 ────────────────────────────────────────────────────────
    v_mat := NULL;
    SELECT m.id INTO v_mat
      FROM materials m JOIN product_materials pm ON pm.material_id = m.id
     WHERE pm.product_id = v_product
       AND m.title = 'Вебинар 1. 3 стратегии коллабораций';
    IF v_mat IS NULL THEN
        INSERT INTO materials (client_id, title, description)
        VALUES (v_client, 'Вебинар 1. 3 стратегии коллабораций',
                '3 стратегии коллабораций и привлечения клиентов без вложений в маркетинг')
        RETURNING id INTO v_mat;

        INSERT INTO material_blocks (material_id, kind, title, body, url, sort_order) VALUES
        (v_mat, 'text', NULL,
         '<h3>3 стратегии коллабораций и привлечения клиентов без вложений в маркетинг</h3>'
         '<p>На вебинаре разобрали:</p>'
         '<ul>'
         '<li>как работать с хабом коллабораторов;</li>'
         '<li>три стратегии коллабораций;</li>'
         '<li>как их реализовать и автоматизировать средствами ПЛЮСОНа и Коллабораторной.</li>'
         '</ul>', NULL, 0),
        (v_mat, 'video', 'Запись вебинара', NULL,
         'https://vk.com/video-212804884_456239051', 10);

        INSERT INTO product_materials (product_id, material_id, title_override, sort_order)
        VALUES (v_product, v_mat, 'Вебинар 1. 3 стратегии коллабораций', 10);
    END IF;

    -- ── Вебинар 2 ────────────────────────────────────────────────────────
    v_mat := NULL;
    SELECT m.id INTO v_mat
      FROM materials m JOIN product_materials pm ON pm.material_id = m.id
     WHERE pm.product_id = v_product
       AND m.title = 'Вебинар 2. Как повышать эффективность эфиров';
    IF v_mat IS NULL THEN
        INSERT INTO materials (client_id, title, description)
        VALUES (v_client, 'Вебинар 2. Как повышать эффективность эфиров',
                'От регистрации — до человека в зале. 10 факторов конверсии')
        RETURNING id INTO v_mat;

        INSERT INTO material_blocks (material_id, kind, title, body, url, sort_order) VALUES
        (v_mat, 'text', NULL,
         '<h3>Как повышать эффективность эфиров: от регистрации — до человека в зале</h3>'
         '<p>На вебинаре разобрали:</p>'
         '<ul>'
         '<li>три этапа эфира;</li>'
         '<li>где в этой цепочке теряются люди;</li>'
         '<li>10 факторов, которые поднимают конверсию;</li>'
         '<li>как каждый фактор реализовать в ПЛЮСОНе.</li>'
         '</ul>', NULL, 0),
        (v_mat, 'video', 'Запись вебинара', NULL,
         'https://vk.com/video-212804884_456239052', 10),
        -- Подарок за отзыв. ⚠️ Отдельным блоком после записи, а не в общем
        -- тексте сверху: до просмотра предложение оставить отзыв об уроке
        -- бессмысленно.
        (v_mat, 'text', NULL,
         '<h3>Подарок за отзыв — дорожная карта эфира</h3>'
         '<p>Посмотрели урок? Напишите отзыв в чат iViSiON — и мы пришлём вам '
         'дорожную карту эфира.</p>', NULL, 20),
        (v_mat, 'button', 'Написать отзыв в Telegram', NULL,
         'https://telegram.me/+YBk8kD-YXf5iZTRi', 30),
        (v_mat, 'button', 'Написать отзыв в MAX', NULL,
         'https://max.ru/join/L2C_6TUGj_ZVHrQwkXaG6Axpc9L4I-n_7MdYct7pyBE', 40);

        INSERT INTO product_materials (product_id, material_id, title_override, sort_order)
        VALUES (v_product, v_mat, 'Вебинар 2. Как повышать эффективность эфиров', 20);
    END IF;

    -- ── Вебинар 3 ────────────────────────────────────────────────────────
    v_mat := NULL;
    SELECT m.id INTO v_mat
      FROM materials m JOIN product_materials pm ON pm.material_id = m.id
     WHERE pm.product_id = v_product
       AND m.title = 'Вебинар 3. Техники переговоров для WIN-WIN партнёрств';
    IF v_mat IS NULL THEN
        INSERT INTO materials (client_id, title, description)
        VALUES (v_client, 'Вебинар 3. Техники переговоров для WIN-WIN партнёрств',
                'Как выстраивать партнёрства через добавочную ценность')
        RETURNING id INTO v_mat;

        INSERT INTO material_blocks (material_id, kind, title, body, url, sort_order) VALUES
        (v_mat, 'text', NULL,
         '<h3>Техники переговоров для выстраивания WIN-WIN партнёрств через добавочную ценность</h3>'
         '<p>На вебинаре разобрали:</p>'
         '<ul>'
         '<li>как знакомиться на нетворкингах через добавочную ценность;</li>'
         '<li>как предлагать коллаборацию так, чтобы с вами хотели партнёриться '
         'и обмениваться аудиторией;</li>'
         '<li>как на примере ПЛЮСОНа поднять ценность своих продуктов и услуг, '
         'не вкладывая в это ни время, ни деньги;</li>'
         '<li>как получать пассивный доход до 200–300 тысяч рублей в год и при '
         'этом пользоваться ПЛЮСОНом бесплатно.</li>'
         '</ul>', NULL, 0),
        (v_mat, 'video', 'Запись вебинара', NULL,
         'https://vk.com/video-212804884_456239054', 10);

        INSERT INTO product_materials (product_id, material_id, title_override, sort_order)
        VALUES (v_product, v_mat, 'Вебинар 3. Техники переговоров для WIN-WIN партнёрств', 30);
    END IF;

    -- ── Афиши и тексты ───────────────────────────────────────────────────
    -- Отдельным материалом, а не блоком внутри вебинара: этим пользуются
    -- постоянно и ищут глазами в списке, а не внутри урока.
    v_mat := NULL;
    SELECT m.id INTO v_mat
      FROM materials m JOIN product_materials pm ON pm.material_id = m.id
     WHERE pm.product_id = v_product
       AND m.title = 'Афиши и тексты для приглашений';
    IF v_mat IS NULL THEN
        INSERT INTO materials (client_id, title, description)
        VALUES (v_client, 'Афиши и тексты для приглашений',
                'Готовые афиши и сообщения — коллегам, участникам нетворкингов, '
                'основателям сообществ и организаторам')
        RETURNING id INTO v_mat;

        INSERT INTO material_blocks (material_id, kind, title, body, url, sort_order) VALUES
        (v_mat, 'text', NULL,
         '<h3>Готовые афиши и тексты сообщений</h3>'
         '<p>Отдельно для коллег, участников нетворкингов, основателей сообществ '
         'и организаторов. Берите и отправляйте.</p>', NULL, 0),
        (v_mat, 'button', 'Открыть папку с материалами', NULL,
         'https://drive.google.com/drive/folders/1MVgapyEuhjI5cdVeuDWQB2NfJvIaUO7l', 10);

        INSERT INTO product_materials (product_id, material_id, title_override, sort_order)
        VALUES (v_product, v_mat, 'Афиши и тексты для приглашений', 40);
    END IF;
END $$;
