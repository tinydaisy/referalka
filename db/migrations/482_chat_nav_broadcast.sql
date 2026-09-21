-- Миграция 482: рассылка «Навигация по чату события» (тип chat_nav).
--
-- Зачем. В чате события человеку нужен ОДИН закреплённый пост, из которого
-- видно всё сразу: куда идти за подарками, где правила, куда писать в
-- поддержку, какие офферы открыты. Собирать его руками нельзя: ссылки
-- РАЗНЫЕ у каждой площадки (в ВК своя, в Телеграме своя), и в чате МАКСа
-- телеграмная ссылка бесполезна.
--
-- Решение: шаблон-конструктор из ПУНКТОВ. У пункта подпись и вид ссылки;
-- сама ссылка подставляется при отправке — под ту площадку, в чат которой
-- уходит сообщение.
--
-- ⚠️ Пункт без ссылки НЕ вставляется вовсе (решение владельца 21.09.2026):
-- правила чата есть не у всех, а «пункт 3» с пустотой после двоеточия
-- выглядит как поломка. Нумерация при этом сквозная и считается ПОСЛЕ
-- отсева — иначе в сообщении получилось бы «1, 2, 4».

-- ── Пункты навигации у шаблона ───────────────────────────────────────────
--
-- ⚠️ JSONB, а не отдельная таблица: пункты не существуют отдельно от шаблона,
-- не ищутся запросами и всегда читаются/пишутся целиком, одним списком.
-- Таблица здесь дала бы join и порядок сортировки на ровном месте.
--
-- ⚠️⚠️ НЕ ПУТАТЬ с `landing_pages.nav_items` — там меню ЛЕНДИНГА (пункты
-- верхней навигации страницы). Таблицы разные, совпало только имя; правка
-- одного к другому отношения не имеет.
--
-- ⚠️ asyncpg отдаёт JSONB СТРОКОЙ (декодер в проекте не настроен) — читающая
-- сторона обязана разбирать через json.loads, иначе фронт получит строку и
-- упадёт на .map. Ровно эта ошибка уже ловилась на лендингах (_ser_page).
--
-- Формат: [{"kind": "...", "label": "...", "url": "...",
--           "magnet_kind": "m|p", "magnet_id": 12}, ...]
--   kind = rules   — правила чата (ссылку клиент вписывает руками, url)
--          vip     — тариф (events.vip_url, как плейсхолдер {vip_url})
--          cabinet — кабинет участника, вкладка подарков (резолв по площадке)
--          support — тех.поддержка (резолв по площадке, как {support_command})
--          magnet  — лид-магнит/пакет (резолв по площадке, как ⟦GF:kind:slug⟧)
--          link    — произвольная ссылка руками
ALTER TABLE broadcast_templates
    ADD COLUMN IF NOT EXISTS nav_items JSONB;

COMMENT ON COLUMN broadcast_templates.nav_items IS
    'Пункты навигации для шаблона chat_nav: [{kind,label,url,magnet_kind,magnet_id}]. Пункт без ссылки не вставляется.';

-- Снимок пунктов в самой рассылке: шаблон могли изменить после постановки
-- в очередь, а уйти должно то, что человек видел при формировании.
ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS nav_items JSONB;

COMMENT ON COLUMN broadcast_schedules.nav_items IS
    'Снимок пунктов навигации на момент постановки в очередь (шаблон мог измениться).';

-- ── Закреп сообщения в чате ──────────────────────────────────────────────
--
-- Закрепляют все три площадки: TG pinChatMessage, VK messages.pin,
-- MAX PUT /chats/{id}/pin. Требование одно — бот админ чата; при
-- автонастройке Telegram право на закреп боту уже выдаётся (tg_setup.py).
-- Не вышло закрепить — сообщение всё равно доставлено, это не ошибка отправки.
ALTER TABLE broadcast_templates
    ADD COLUMN IF NOT EXISTS pin_in_chat BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE broadcast_schedules
    ADD COLUMN IF NOT EXISTS pin_in_chat BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN broadcast_templates.pin_in_chat IS
    'Закреплять сообщение в чате после отправки (TG/VK/MAX). Нужны права админа у бота.';
COMMENT ON COLUMN broadcast_schedules.pin_in_chat IS
    'Закреплять сообщение в чате после отправки. Наследуется от шаблона, как send_to_event_chats.';

-- ── Те же флаги в библиотеке дефолтов (миграция 217) ─────────────────────
--
-- ⚠️ Без них авто-сид создал бы шаблон с send_to_event_chats=FALSE: доставка
-- в чат у нас наследуется от шаблона, и навигация по чату молча ушла бы
-- в личку участникам вместо чата.
ALTER TABLE default_broadcast_templates
    ADD COLUMN IF NOT EXISTS send_to_event_chats BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE default_broadcast_templates
    ADD COLUMN IF NOT EXISTS pin_in_chat BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE default_broadcast_templates
    ADD COLUMN IF NOT EXISTS nav_items JSONB;

-- ── Шаблон в библиотеку ──────────────────────────────────────────────────
--
-- ⚠️ Только конференции и премии/турниры (for_event=FALSE): у обычного
-- вебинара чата события с навигацией по программе и спикерам нет.
--
-- autoseed=TRUE — НОВЫЕ конференции и премии получают шаблон сразу; уже
-- существующие добавляют его через «Добавить готовый шаблон» (там список
-- берётся без учёта autoseed).
--
-- ⚠️ Текст здесь — только ШАПКА и подпись. Сами пункты живут в nav_items и
-- подставляются на место {chat_nav_items}: у них ссылки под площадку, а в
-- плоском тексте такую подстановку не выразить.
INSERT INTO default_broadcast_templates
    (type, name, subject, text, schedule_mode, offset_minutes,
     audience_include, audience_exclude, allow_custom_datetime,
     for_event, for_conference, for_turnir, autoseed, multi_instance,
     send_to_event_chats, pin_in_chat, nav_items,
     turnir_name, is_active, sort_order)
VALUES (
    'chat_nav',
    'Навигация по чату (закреп)',
    NULL,
    E'🚨 <b>НАЧНИ ОТСЮДА — ЗАБЕРИ 🎁 ПОДАРКИ</b>\n\n{chat_nav_items}',
    'fixed_offset',
    0,
    'all_event', 'all_event',   -- в личку не уходит: адресат — чат события
    TRUE,                        -- время выбирает клиент: пост-навигация не привязана к программе
    FALSE, TRUE, TRUE,
    TRUE,
    FALSE,
    TRUE,                        -- send_to_event_chats: адресат — чат события
    TRUE,                        -- pin_in_chat: навигация имеет смысл только в закрепе
    -- Пункты заполнены сразу (решение владельца 21.09.2026): пустой
    -- конструктор человек закрывает, не поняв, что в нём собирать.
    -- Ссылка у «правил» пустая — пункт не вставится, пока её не впишут.
    E'[{"kind":"vip","label":"Повысить тариф и получить доступ к Коллабораторной:"},'
    '{"kind":"cabinet","label":"🎁 Подарки за регистрацию и активность • Ваш кабинет участника • Программа • Спикеры:"},'
    '{"kind":"rules","label":"Правила нетворкинга:","url":""},'
    '{"kind":"support","label":"Тех.поддержка. Если возникнет вопрос — пишите:"}]'::jsonb,
    'Навигация по чату (закреп)',
    TRUE,
    95
)
ON CONFLICT (type) DO NOTHING;

-- ⚠️ ON CONFLICT DO NOTHING выше — no-op, если строка уже есть (урок миграции
-- 432: правка тела INSERT на проде молча не применяется). Поэтому доставку и
-- заполнение правим отдельным UPDATE — он выполнится в любом случае.
UPDATE default_broadcast_templates
   SET name       = 'Навигация по чату (закреп)',
       text       = E'🚨 <b>НАЧНИ ОТСЮДА — ЗАБЕРИ 🎁 ПОДАРКИ</b>\n\n{chat_nav_items}',
       for_event  = FALSE,
       for_conference = TRUE,
       for_turnir = TRUE,
       autoseed   = TRUE,
       allow_custom_datetime = TRUE,
       send_to_event_chats = TRUE,
       pin_in_chat = TRUE,
       nav_items  = COALESCE(nav_items,
           E'[{"kind":"vip","label":"Повысить тариф и получить доступ к Коллабораторной:"},'
           '{"kind":"cabinet","label":"🎁 Подарки за регистрацию и активность • Ваш кабинет участника • Программа • Спикеры:"},'
           '{"kind":"rules","label":"Правила нетворкинга:","url":""},'
           '{"kind":"support","label":"Тех.поддержка. Если возникнет вопрос — пишите:"}]'::jsonb),
       is_active  = TRUE
 WHERE type = 'chat_nav';
