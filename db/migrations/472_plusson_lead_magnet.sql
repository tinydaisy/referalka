-- 472. Плюсоновский лид-магнит — один у каждого клиента, неудаляемый (20.09.2026).
--
-- ЗАЧЕМ.
-- Клиент раздаёт своей аудитории доступ к самому ПЛЮСОНу и получает с этого
-- реферальные начисления. Раньше, чтобы так сделать, ему надо было завести
-- лид-магнит руками и выбрать в нём режим ссылки `plusson_self` — то есть
-- догадаться, что такой режим вообще есть. Догадывались единицы.
--
-- Теперь такой лид-магнит есть У КАЖДОГО клиента с первой минуты: он создаётся
-- при регистрации, а существующим раздан этой миграцией. Удалить его нельзя —
-- это не материал клиента, а инструмент платформы, лежащий у него в кабинете.
--
-- ⚠️⚠️ НАЗВАНИЕ И ОПИСАНИЕ — ОДНИ НА ВСЮ ПЛАТФОРМУ, из админки. Это текст
-- предложения самого ПЛЮСОНа, и он меняется: сегодня «20+ решений», завтра
-- другое число. Если бы каждый клиент правил свой экземпляр, текст разъехался
-- бы по тысяче кабинетов, и обновить его разом стало бы невозможно.
--
-- ⚠️ Но хранить текст ТОЛЬКО в настройке и подставлять на лету нельзя:
-- `lead_magnets.name` читают десятки мест (рассылки, воронки, подарки события,
-- витрина Mini App, CRM). Поэтому настройка — источник правды, а при её
-- сохранении текст переписывается во ВСЕХ экземплярах разом (sync в
-- app/services/plusson_lead_magnet.py). Одно место правки, но читатели видят
-- обычную колонку и ничего о платформенной настройке не знают.
--
-- ⚠️ Ссылку настраивать не надо и НЕЛЬЗЯ: режим `plusson_self` (миграция 399)
-- собирает её сам в момент выдачи — под площадку человека (из Telegram в
-- Telegram, из ВК в ВК, из MAX в MAX) и с реф-кодом этого клиента.

BEGIN;

-- ─────────────────── 1. Признак на лид-магните ───────────────────
ALTER TABLE lead_magnets
    ADD COLUMN IF NOT EXISTS is_plusson BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lead_magnets.is_plusson IS
    'Платформенный лид-магнит «Доступ к ПЛЮСОНу»: заводится автоматически у '
    'каждого клиента, удалению не подлежит, название/описание задаются в '
    'админке одни на всех (platform_settings.plusson_lm_*)';

-- ⚠️ ОДИН на клиента, гарантируем индексом, а не только кодом. Повторный вызов
-- «создай, если нет» при гонке (регистрация + фоновая задача) иначе завёл бы
-- второй экземпляр, и клиент увидел бы в списке два одинаковых подарка.
CREATE UNIQUE INDEX IF NOT EXISTS lead_magnets_plusson_uidx
    ON lead_magnets(client_id) WHERE is_plusson;

-- ─────────────────── 2. Настройка платформы ───────────────────
ALTER TABLE platform_settings
    ADD COLUMN IF NOT EXISTS plusson_lm_name        TEXT,
    ADD COLUMN IF NOT EXISTS plusson_lm_description TEXT,
    -- Как отдаётся подарок по прямой ссылке `/m/{slug}`:
    --   direct — сразу в бот ПЛЮСОНа (по умолчанию);
    --   funnel — сначала в бот клиента, как у обычного лид-магнита.
    ADD COLUMN IF NOT EXISTS plusson_lm_delivery    TEXT NOT NULL DEFAULT 'direct';

ALTER TABLE platform_settings DROP CONSTRAINT IF EXISTS platform_settings_plusson_lm_delivery_check;
ALTER TABLE platform_settings
    ADD CONSTRAINT platform_settings_plusson_lm_delivery_check
    CHECK (plusson_lm_delivery IN ('direct', 'funnel'));

COMMENT ON COLUMN platform_settings.plusson_lm_delivery IS
    'Куда ведёт прямая ссылка Плюсоновского лид-магнита: direct — сразу в бот '
    'ПЛЮСОНа (догревает команда платформы); funnel — через бот клиента, как '
    'обычный лид-магнит (человек остаётся в базе клиента)';

-- ⚠️ Строка настроек единственная (CHECK id = 1) и уже существует — но на
-- пустой базе её может не быть, поэтому создаём при отсутствии.
INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

UPDATE platform_settings
   SET plusson_lm_name = '20+ готовых тех.решений и Коллабораторная + Продлённый доступ к платформе «iViSiON: ПЛЮСОН» для привлечения клиентов. Внедряются без тех.спеца сразу в ТГ, МАХ, ВК.'
 WHERE id = 1 AND COALESCE(plusson_lm_name, '') = '';

-- ─────────────────── 3. Откуда пришёл приведённый клиент ───────────────────
--
-- ⚠️ Нужно, чтобы отличить пришедших С ЭТОГО ЛИД-МАГНИТА от пришедших по
-- обычной реф-ссылке клиента: и там, и там один и тот же реф-код, и без
-- отдельной пометки эти два потока в партнёрке неразличимы.
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS referred_source TEXT;

COMMENT ON COLUMN clients.referred_source IS
    'Чем именно привели этого клиента: plusson_lm — Плюсоновским лид-магнитом '
    'партнёра; NULL — обычной реф-ссылкой (как было у всех до 20.09.2026)';

CREATE INDEX IF NOT EXISTS clients_referred_source_idx
    ON clients(referred_by_client_id, referred_source)
    WHERE referred_source IS NOT NULL;

-- ⚠️ Тем же признаком помечаем КОНТАКТ в базе бота ПЛЮСОНа: человек нажал
-- /start задолго до регистрации, и к моменту заведения кабинета помнить, чем
-- его привели, больше негде.
ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS plusson_referrer_source TEXT;

COMMENT ON COLUMN contacts.plusson_referrer_source IS
    'Чем человека привели в ПЛЮСОН: plusson_lm — Плюсоновским лид-магнитом; '
    'NULL — обычной реф-ссылкой. Переезжает в clients.referred_source при '
    'регистрации';

-- ─────────────────── 4. Раздаём существующим клиентам ───────────────────
--
-- ⚠️ `url` = '{plsn_bot}' — тот же плейсхолдер, что ставит форма при режиме
-- `plusson_*` (см. `_url_for_source` в api/lead_magnets.py). Колонка NOT NULL,
-- а настоящий адрес подставляет сервер в момент выдачи.
--
-- ⚠️ `link_mode = 'both'` — ссылка и текстом, и кнопкой: так же, как у
-- заготовок автонастройки. Голая ссылка в тексте на телефоне промахивается
-- мимо пальца, кнопка — нет.
DO $$
DECLARE
    r         RECORD;
    new_slug  TEXT;
    alphabet  TEXT := '23456789abcdefghjkmnpqrstuvwxyz';
    attempts  INT;
    lm_name   TEXT;
    lm_descr  TEXT;
BEGIN
    SELECT plusson_lm_name, plusson_lm_description
      INTO lm_name, lm_descr
      FROM platform_settings WHERE id = 1;

    FOR r IN SELECT id FROM clients
              WHERE NOT EXISTS (SELECT 1 FROM lead_magnets lm
                                 WHERE lm.client_id = clients.id AND lm.is_plusson)
    LOOP
        attempts := 0;
        LOOP
            new_slug := '';
            FOR i IN 1..5 LOOP
                new_slug := new_slug || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
            END LOOP;
            -- ⚠️ Уникальность проверяем И по пакетам: slug у них общий (см.
            -- `_make_unique_lead_magnet_slug`), адреса /m/ и /p/ не должны
            -- столкнуться.
            IF NOT EXISTS (SELECT 1 FROM lead_magnets WHERE slug = new_slug)
               AND NOT EXISTS (SELECT 1 FROM lead_magnet_packages WHERE slug = new_slug) THEN
                EXIT;
            END IF;
            attempts := attempts + 1;
            IF attempts > 50 THEN
                RAISE EXCEPTION 'Не удалось подобрать slug для Плюсоновского лид-магнита клиента %', r.id;
            END IF;
        END LOOP;

        INSERT INTO lead_magnets
            (client_id, name, description, url, slug, link_mode, button_label,
             link_source, is_plusson)
        VALUES
            (r.id, lm_name, lm_descr, '{plsn_bot}', new_slug, 'both',
             'Забрать доступ', 'plusson_self', TRUE);
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON platform_settings TO plusson;

COMMIT;
