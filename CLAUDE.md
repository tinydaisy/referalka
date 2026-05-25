# CLAUDE.md — Правила работы с проектом

> Этот файл Claude Code читает автоматически при каждом старте сессии.

---

## Что это за проект

**iViSiON: ПЛЮСОН** — Платформа для организаторов и экспертов: управляйте событием от А до Я — спикеры, рассылки, рефералы в одном месте. Создатель: Марго Форбс.

> **Брендирование (с 2026-05-08).** В UI везде — «iViSiON: ПЛЮСОН» (двоеточие, пробел, регистр буква-в-букву). Слоган в шапках/сайдбаре/login/splash — «Платформа для организаторов и экспертов: управляйте событием от А до Я — спикеры, рассылки, рефералы в одном месте». Старые формулировки («Платформа событийного и реферального маркетинга», «Платформа управляемого вирального роста») не использовать. Технические идентификаторы (`@pluson_bot`, `pluson.ru`, `system@pluson.ru`, имя системного клиента «ПЛЮСОН Сервис» в БД) — остаются как есть, не трогать.
Клиенты создают события, Участники получают реферальные ссылки и приглашают друзей за ценностные подарки.

Бизнес-описание продукта: [documentation/BRIEF.md](documentation/BRIEF.md)
Технический план бэкенда: [documentation/BACKEND-PLAN.md](documentation/BACKEND-PLAN.md)
План разработки MVP: [documentation/PLAN.md](documentation/PLAN.md)
Сценарии тестирования: [documentation/TESTING.md](documentation/TESTING.md)

---

## Правила работы

> ### ⚠️ СЕРВЕР ПО УМОЛЧАНИЮ — DEV
> **Все правки и эксперименты идут на DEV-сервер `62.113.98.30` (dev.pluson.ru, старый dev.pluson.margoforbs.ru работает параллельно).**
> **Прод `194.156.119.17` (pluson.ru / www.pluson.ru, старый pluson.margoforbs.ru работает параллельно) — ТОЛЬКО по явной команде пользователя** («деплой на прод», «выкати на продакшн» и т.п.).
> Не переспрашивать каждый раз — реквизиты и пароли в `memory/dev_server.md` и `memory/server_access.md`.

- Всегда отвечать на **русском языке**
- Это **no-code / AI-driven разработка** — весь код пишет Claude, пользователь не программист
- Перед началом новой задачи читать `documentation/PLAN.md` чтобы понимать текущий статус
- Объяснять технические решения простым языком
- Не усложнять — MVP строится минимальными средствами, достаточными для работы

### Автообновление документации (ОБЯЗАТЕЛЬНО, без напоминаний)
После **любой** разработки — новая фича, баг-фикс, рефакторинг, миграция БД, новый API-эндпоинт, новая страница, изменение сервера или окружения — Claude **сам** обновляет документацию в этой же сессии, без просьб со стороны пользователя. Это не опция, а правило.

Что и куда писать:
- **`CLAUDE.md`** — архитектурные решения, новые правила, изменения окружения (сервера, домены, режимы работы)
- **`PROJECT_DOCUMENTATION.md`** — значимые изменения продукта и архитектуры
- **`documentation/PLAN.md`** — отметки `[x]` у выполненных пунктов; новые задачи — как `[ ]`
- **`documentation/BACKEND-PLAN.md`** — новые таблицы БД, API-эндпоинты, правила доступа
- **`documentation/TESTING.md`** — новые сценарии тестирования
- **`memory/*.md`** — ссылки/реквизиты/решения, которые нужны в будущих сессиях (через `MEMORY.md`)

Правило простое: если сделал изменение — сразу записал. Пользователь не должен напоминать.

### Код и вёрстка
- **Без внешних UI-библиотек** — все страницы строятся без сторонних компонентных библиотек (без Bootstrap, MUI, Ant Design и подобных). Tailwind CSS — допустим, shadcn/ui — допустим, всё остальное — нет
- **Адаптивная вёрстка** — каждая страница должна хорошо выглядеть на мобильном экране. Проверять вёрстку на ширине 375px

### Создание файлов
- **Перед созданием нового файла** — сначала объяснить: что это за файл, зачем он нужен, что в нём будет. Только после этого создавать

### Стиль текста в интерфейсе
- **Простой и дружеский** — никакого официоза и канцелярита
- Вместо «Осуществите переход» → «Перейдите»
- Вместо «Данная функция» → «Эта функция»
- Вместо «Произведите настройку» → «Настройте»
- Тон: как разговор с умным другом, который помогает

### Деплой и тестирование
- **Два сервера:**
  - **Dev:** `62.113.98.30` / `dev.pluson.ru` (Ubuntu 24.04). Старый `dev.pluson.margoforbs.ru` работает параллельно. Все новые правки сначала идут сюда
  - **Прод:** `194.156.119.17` / `pluson.ru` (www-версия и старый `pluson.margoforbs.ru` работают параллельно). Деплой на прод — только после явного подтверждения пользователя
- **Деплой только через git** — commit локально → `git push` → на сервере `git pull` + build + рестарт. **Никогда** не редактируем файлы напрямую на сервере, не используем `scp` для точечной доставки. Исключение: разовые серверные команды (рестарт, логи, psql, установка пакетов)
- **Production-режим везде** — даже на dev запускаем через `npm start` (не `npm run dev`), перед деплоем всегда `npm run build`
- **Тестирование после каждого запроса** — после каждого изменения обязательно протестировать как реальный пользователь через dev-домен и Telegram Mini App. Описать результаты в ответе
- Полные реквизиты серверов — в `memory/server_access.md` (прод) и `memory/dev_server.md` (dev)
- **Cloudflare R2** (хранилище афиш и картинок) — бакет `referalka`, ключи и endpoint в `memory/r2_storage.md`. Переменные окружения: `CF_ACCOUNT_ID`, `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, `CF_R2_BUCKET_NAME`, `CF_R2_PUBLIC_URL` (лежат в `web/.env.local` на обоих серверах)
- **Cloudflare DNS/Proxy** (с 2026-05-14) — `pluson.ru`, `www.pluson.ru`, `dev.pluson.ru` за Cloudflare Free с оранжевой тучей (Proxied). Аккаунт `margarita.forbs1@gmail.com` (другой от R2). NS в Reg.ru переключены на `*.ns.cloudflare.com`. SSL/TLS режим **Full (strict)** + Always Use HTTPS. Решает `net::ERR_TIMED_OUT` для пользователей с зарубежным VPN (Beget RU плохо доступен из-за рубежа). Лимит upload через CF = 100 МБ. Подробности — `memory/project_cloudflare_setup.md`. `margoforbs.ru` пока НЕ за CF.

---

## Технологический стек

| Слой | Технология |
|---|---|
| База данных | PostgreSQL 16 (на Beget VPS) |
| Web-кабинет Клиента | Next.js 14 + Tailwind CSS + shadcn/ui |
| Backend / бизнес-логика | Python + FastAPI |
| Telegram Bot | Python + aiogram 3 |
| Telegram Mini App | React + Vite + @telegram-apps/sdk |
| Очереди задач (рассылки) | Celery + Redis |
| Хостинг всего | Beget VPS 194.156.119.17 |
| Домен | pluson.ru (Reg.ru DNS → VPS), старый pluson.margoforbs.ru работает параллельно |

---

## Ключевые архитектурные решения (зафиксированы, не менять)

### Тексты-анонсы + вкладка «Материалы» в кабинете спикера (миграция 112 от 2026-05-25)

**Зачем.** Параллельно с реф-программой («зови друзей за подарки» — аудитория участник) — отдельная сущность для спикеров/партнёров: готовые тексты-анонсы события. Их собирает организатор, а спикер открывает свой self-service кабинет, копирует и шлёт своей аудитории.

**БД (миграция 112):** `event_announcement_texts (id, event_id, content, sort, created_at, updated_at)`. Отдельная от `event_referral_share_texts` — у них разные аудитории и разные плейсхолдеры.

**Плейсхолдеры** (подставляются в момент копирования на фронте кабинета спикера):
- `{link}` — личная реф-ссылка спикера (TG приоритет, fallback VK→MAX)
- `{event}` — название события (events.title)
- `{date}` — `DD.MM.YYYY HH:MM МСК` (из events.start_at)
- `{brand}` — `clients.brand_name || clients.name`

**API CRUD** ([backend/app/api/referral_program.py](backend/app/api/referral_program.py)) — `/api/v1/events/{id}/announcement-texts` (GET/POST/PATCH/DELETE). UI на фронте — общий компонент [`AnnouncementTextsBlock`](web/src/components/AnnouncementTextsBlock.tsx), используется в обеих `PostersTab.tsx` (events + conferences).

**Дашборд: подвкладки в «Афишах».** Вкладка `PostersTab` (карточка мероприятия + карточка конференции) теперь содержит 2 подвкладки:
- **Афиши** — текущий UI (3 ориентации, загрузка)
- **Материалы** — CRUD текстов-анонсов с подсказкой плейсхолдеров

**Кабинет спикера: 2 вкладки.** [/speaker/<event_slug>](web/src/app/speaker/%5Bevent_slug%5D/page.tsx) переведён с одной длинной страницы на табы:
- **Профиль** — всё что было (поля, фото, темы, регалии, медийные активы, подарки, материал в базу знаний)
- **Материалы** (новая) — внутренний компонент `MaterialsTab`. Содержит:
  1. Афиши события (превью + кнопка «Скачать», открытие в lightbox)
  2. Тексты-анонсы с уже подставленными плейсхолдерами + кнопка «Скопировать»
  3. Реф-ссылки спикера (TG/VK/MAX) — **перенесены сюда из шапки**
  4. **Партнёрская ссылка спикера** — новое. Логика: если у `contacts.first_referrer_contact_id` есть значение → `prtp_<first_referrer_contact_id>` (партнёр регистрируется через рефовода спикера); если рефовода нет → корневая `prtc_<client_id>`. Только если `clients.partner_landing_url` заполнен. Платформы — те, где у клиента есть подключённый канал; TG fallback на `@pluson_bot`; email/телефон не показываем.

**Endpoint поставщика данных** — `GET /api/v1/public/speaker-cabinet/me/materials` ([backend/app/api/speaker_cabinet.py](backend/app/api/speaker_cabinet.py)). Отдаёт `{posters, announcement_texts, ref_links, partner_link, partner_landing_configured, placeholders}`. Логика партнёрской ссылки переиспользует `share_links.get_active_platforms / get_client_bot_handles / get_client_vk_app_id / _has_system_channel`.

### Контакты — фильтры по событиям/лид-магнитам/пакетам + CSV-экспорт (07.05.2026)

В дашборде «Контакты» (`/dashboard/clients`) фильтр-панель переведена на единый стиль выпадающих мульти-селект с поиском по названию ([`MultiSelectDropdown.tsx`](web/src/components/MultiSelectDropdown.tsx)).

**Новые фильтры** (мульти-выбор + поиск):
- **События** (`event_ids` CSV) — контакт был участником хотя бы одного из выбранных. JOIN на `event_participants.contact_id`.
- **Лид-магниты** (`lead_magnet_ids` CSV) — контакт зашёл по ссылке хотя бы одного из выбранных. JOIN на `funnel_runs.contact_id WHERE lead_magnet_id IN (...)`.
- **Пакеты лид-магнитов** (`package_ids` CSV) — аналогично через `funnel_runs.package_id`.

**Изменения существующих фильтров:**
- **Каналы подписки** — теперь выпадающий мульти-селект. «Без привязки к каналу» (orphan) — пункт списка, не отдельный чекбокс. Если в дропдауне ничего не выбрано — фильтр по каналам не активен (показывает всех).
- **Теги, UTM, События, Лид-магниты, Пакеты** — все выпадающие мульти-селект с поиском.

**Querystring-синхронизация.** Состояние фильтров отражено в URL (`?lead_magnet_ids=2&utm_sources=insta&…`). Deep-link работает со страницы лид-магнитов — клик по счётчику ведёт на `/dashboard/clients?lead_magnet_ids=N`, и фильтр уже выставлен.

**Кнопка «Экспорт CSV»** (`Download` icon в шапке). `GET /api/v1/contacts/export` принимает те же фильтры, отдаёт UTF-8 файл с BOM и `;`-разделителем (для Excel). Колонки: ID, Имя, Email, Телефон, Реф-код, UTM, Теги, Telegram/VK/MAX (с username и id), Каналы (подписан/отписан), Откуда пришёл, Создан, Последний контакт.

**Счётчик «зашло» в `/dashboard/lead-magnets`.** Рядом с иконками действий — персиковая плитка `<Users> N`. Цифра = `COUNT(DISTINCT contact_id)` из `funnel_runs` (поле `known` в ответе `GET /lead-magnets/counts` и `GET /lead-magnet-packages/counts`). Анонимные `landed` без `contact_id` в счётчик не попадают, чтобы при клике на цифру (→ `?lead_magnet_ids=N` / `?package_ids=N`) пользователь увидел **ровно столько же** контактов.

WHERE-логика контактов вынесена в хелпер [`_build_contacts_filter`](backend/app/api/contacts.py) — переиспользуется и в `GET /contacts`, и в `GET /contacts/export`.

### Канал подписки в воронке — https-ссылка, не @-префикс (07.05.2026)

В тексте «Чтобы получить материалы — подпишись на канал X и жми «ГОТОВО»» X — теперь всегда **https-ссылка** (`https://t.me/foo` или `https://t.me/+abc…`). Раньше код добавлял `@` к чему угодно, и для инвайт-кода закрытого канала получался мусор `@+w1sFWX...`.

**Где:** новый модуль [`backend/app/services/social_links.py`](backend/app/services/social_links.py):
- `normalize_telegram_link(s)` — любой ввод (`@name`, `t.me/foo`, `+abc`, `name`, `https://...`) → `https://t.me/...`. Если строка не похожа на Telegram (например `https://vk.com/...`) — возвращает её как есть.
- `telegram_api_id(s)` — из того же ввода → `@channelname` для `getChatMember`. Для инвайт-кода `+abc…` возвращает `''` (через Bot API проверить подписку на закрытый канал по инвайт-коду нельзя — нужен числовой `chat_id`).
- `normalize_social_links(social)` — нормализует `social_links.telegram` целиком.

**Как используется:**
- [`funnel_service._get_brand_context`](backend/app/services/funnel_service.py) кладёт в ctx два значения: `subscription_channel` (https — для текста) и `subscription_channel_api` (@-формат — для проверки подписки в `run_check_subscription`).
- [`client_profile.PATCH /me/profile`](backend/app/api/client_profile.py) применяет `normalize_social_links` перед записью — поле в БД сразу хранится в каноничном https-формате.
- Поле «Telegram» в `/dashboard/mini-app` → вкладка «Основатель» → раздел «Соцсети» снабжено подсказкой «Полная ссылка через https. Для закрытого канала — инвайт-ссылка `https://t.me/+abcDEF…`».

### Воронки выдачи лид-магнитов (миграции 062, 063 от 05.05.2026)

**Зачем.** Лид-магниты выдаются через бот по фиксированной схеме: «приветствие со списком подарков → проверка подписки на канал → выдача файлов → 30-минутный follow-up». Можно объединять несколько лид-магнитов в один пакет под единой ссылкой.

**Где живёт ссылка на воронку (платформа в query, с 2026-05-20):**
- Одиночный лид-магнит: `pluson.ru/m/{slug}?to={tg|vk|max}` (5-символьный код алфавит без визуально похожих)
- Пакет: `pluson.ru/p/{slug}?to={tg|vk|max}`
- С UTM и партнёром: `pluson.ru/m/x7q9k?to=tg&utm_source=insta&pid=abc123`. UTM любые — всё в `funnel_runs.utm` JSONB. `pid` резолвится в `referrer_contact_id` через `contacts.ref_code`.
- **Платформа обязательна в UI.** Дашборд `/dashboard/lead-magnets` под каждым лид-магнитом и пакетом показывает столько ссылок, сколько у клиента подключено площадок (с учётом `client_channels` + системных каналов с `is_test=FALSE`). Каналы в test-режиме у клиентов не светятся. URL без `?to=` поддержан для обратной совместимости — default = TG.
- **Формирование ссылок** — [`build_funnel_landing_links`](backend/app/services/share_links.py) (kind='m'|'p') возвращает `{telegram?, vk?, max?}`. Используется в GET `/lead-magnets` и `/lead-magnet-packages` (поле `platform_links`).

**Куда ведёт landing (зависит от `?to=`):**
- `to=tg` (default): VIP с фичей `channels` и подключённым TG-ботом → `t.me/<его_бот>?start=fnl_<run_id>`, иначе → `t.me/pluson_bot?start=fnl_<run_id>`
- `to=vk`: VIP с подключённым VK Mini App (`channels.platform_meta.vk_app_id`) → `vk.com/app{vip_app_id}#fnl_<run_id>`, иначе → системный `vk.com/app54592404#fnl_<run_id>`
- `to=max`: VIP с подключённым MAX-ботом (handle в `channels.handle`) → `max.ru/{vip_handle}?startapp=fnl_<run_id>`, иначе → системный `max.ru/id890306512862_1_bot?startapp=fnl_<run_id>`
- На этапе landing записывается `funnel_runs.platform_slug` — потом обработчик бота своей платформы подхватывает run по run_id. VK/MAX-обработчики в боте пишутся отдельно — URL уже отдаются клиентам корректно.

В обоих случаях наш polling-сервис ([backend/bot/main.py](backend/bot/main.py)) держит обработчики. Multi-bot polling: один Python-процесс крутит и @pluson_bot, и все VIP-боты клиентов параллельно через asyncio.gather.

**VK-воронка лид-магнитов (с 2026-05-20).** Параллельно с TG работает VK Long Poll consumer ([backend/bot/vk_main.py](backend/bot/vk_main.py)). Ссылка `pluson.ru/m/{slug}?to=vk` ведёт в чат с VK-сообществом клиента (`vk.me/{handle}?ref=fnl_<run_id>`). VK при первом сообщении пользователя кладёт `ref` в `message.ref` / `message.payload.ref` / `message.ref_source` (либо в `event.ref` для message_allow). Бот парсит ref → запускает [`run_started_vk`](backend/app/services/funnel_service.py) (VK-аналог `run_started` для TG): создаёт contact + platform_users('vk') + подписку на client_channel сообщества + шлёт Текст 1 с callback-кнопкой «ГОТОВО». Кнопка → `message_event` с payload `{cb: "fnl_check_<run_id>"}` → [`run_check_subscription`](backend/app/services/funnel_service.py) с `platform='vk'` → проверка подписки через `groups.isMember(vk_group_id, user_id)` + выдача материалов через VK API. **Системное VK-сообщество ПЛЮСОНа НЕ используется для воронок чужих клиентов** — у клиента должно быть подключено собственное сообщество (см. `_platform_redirect_url` в [funnels.py](backend/app/api/funnels.py)). Аналогично для MAX.

**VK подписочное сообщество клиента** хранится в `clients.social_links.vk` (поле в визитке Основателя на `/dashboard/settings`). При PATCH `/me/profile` бэк автоматически резолвит VK screen_name → числовой group_id через `utils.resolveScreenName` и кладёт рядом в `social_links.vk_group_id`. Этот group_id используется для `groups.isMember` при проверке подписки в воронке. Для существующих клиентов сделан одноразовый бэкфилл-скрипт `/tmp/vk_backfill.py`. Нормализация ссылок — [`normalize_vk_link` / `vk_screen_name_from_link`](backend/app/services/social_links.py).

**Бот-флоу:**
1. `/start fnl_<run_id>` ([backend/bot/handlers/start.py](backend/bot/handlers/start.py)) — создаём `contact` + `platform_users` если новый человек, ставим `stage=started`, шлём уведомление организатору, отправляем **Текст 1** с inline-кнопкой «ГОТОВО».
2. Callback `fnl_check_<run_id>` ([backend/bot/handlers/funnel.py](backend/bot/handlers/funnel.py)) — `getChatMember` на `clients.social_links.telegram`. Если подписан → `stage=delivered`, шлём **Текст 2** со списком `1. Название — <ссылка>`, шедулим Celery `app.tasks.funnel.send_text_3` на 30 мин. Если нет — алерт «Не вижу подписки на канал». **Повторное нажатие «ГОТОВО»** (run уже delivered) — шлём Текст 2 заново, без сообщения «уже отправлены»; таймер Текст 3 при повторе не плодится.
3. Через 30 мин Celery шлёт **Текст 3** ([backend/app/services/funnel_service.py](backend/app/services/funnel_service.py) `send_text_3`): версия `delivered` для получивших, `stuck` для зависших.

**Канал подписки.** Бот проверяет подписку на канал, который клиент вписал в `clients.social_links.telegram` (визитка основателя в `/dashboard/mini-app`, вкладка «Основатель»). Бот должен быть админом этого канала. Если поле пустое — проверку пропускаем, выдаём сразу.

**Канал уведомлений организатору** (`clients.notifications_telegram_chat_id`):
- Уведомления всегда шлёт @pluson_bot (даже для VIP). Формат: «🆕 Новый интерес: <магнит/пакет> · кто пришёл (`@username` · `#contact_id`) · UTM · кто привёл · ссылки на карточки контактов».
- Шлётся при первом переходе `landed → started`.
- VIP-клиент добавляет @pluson_bot админом в свой служебный канал, пересылает любое сообщение из канала в @pluson_bot — handler `/getchatid` отвечает с chat_id.
- Поле настраивается в `/dashboard/settings` → вкладка «Технические» → блок «Канал уведомлений» с инструкцией.

**Шаблон воронки** ([backend/app/api/funnels.py](backend/app/api/funnels.py)) — один на клиента, тип `'lead_magnet'`. Auto-create при первом GET с дефолтными текстами. 5 редактируемых полей: `text_1`, `button_label`, `text_2`, `text_3_delivered`, `text_3_stuck`. Создание новых шаблонов нельзя, только править существующий. Плейсхолдеры подставляются в момент отправки: `{materials_list}` (нумерованный список названий через пустую строку — двойной перенос), `{materials_with_links}` (название + ссылка), `{client_brand_name}`, `{client_owner_name}`, `{client_owner_bio}` (биография из `clients.bio`), `{client_owner_achievements}`, `{subscription_channel}`, `{owner_telegram}`. Сообщения уходят с `parse_mode=HTML` — можно использовать `<b>`, `<i>`, `<a href>`.

**Медиа в шаблоне (миграция 077 от 14.05.2026).** К Тексту 1 и Тексту 2 можно прикрепить фото или видео (поля `text_1_media_url`, `text_1_media_type`, `text_2_media_url`, `text_2_media_type`; CHECK на `photo|video`). Загрузка — через `POST /api/v1/uploads` с `kind='funnel_media'`. Ресайз картинок — до 1920px (видео не ресайзится). Логика отправки в `_send_text_with_media` ([backend/app/services/funnel_service.py](backend/app/services/funnel_service.py)):
- нет медиа → `sendMessage` (как раньше);
- медиа + `len(text) ≤ 1024` → одно сообщение `sendPhoto`/`sendVideo` с caption + inline-кнопкой (`TG_CAPTION_LIMIT = 1024`);
- медиа + текст длиннее → `sendPhoto`/`sendVideo` без caption + `sendMessage` с полным текстом и кнопкой.

**Аналитика лид-магнита/пакета** — 3 счётчика по `funnel_runs.stage`:
1. **landed** — перешли по ссылке (включая отвал не дошедших до бота)
2. **started** — открыли бот, нажали /start, получили Текст 1
3. **delivered** — прошли проверку подписки, получили файлы

GET `/api/v1/lead-magnets/{id}/analytics` и `/api/v1/lead-magnet-packages/{id}/analytics`. UI: кнопка-иконка в строке открывает модалку с переключателем счётчиков и таблицей интересантов.

**Карточка контакта** — секция «Лид-магниты» под секцией «События»: список `funnel_runs` контакта с этапами и UTM. Эндпоинт `GET /api/v1/contacts/{id}` дополнен полем `lead_magnet_runs[]`.

**Дашборд `/dashboard/lead-magnets`** — 3 подвкладки:
- «Лид-магниты» — список + slug (read-only с копированием), иконка аналитики
- «Пакеты» — мульти-селект из лид-магнитов с сортировкой ↑↓, общая ссылка `pluson.ru/p/{slug}`
- «Шаблон воронки» — редактор 4 текстов и кнопки

**nginx.** На dev добавлен location `^/(m|p)/[a-z0-9]+$` → FastAPI 8000 (см. `memory/dev_server.md`).

### Единый набор GET-параметров на все внешние URL клиента (миграция 105+, обновлено 2026-05-24)

**Где применяется:** ВСЕ места, где открывается сторонний URL клиента:
- `events.landing_url` — лендинг события (Mini App `redirectToExternalLanding`, SSR `/l/[slug]`, `/landing-redirect` endpoint)
- `events.vip_url` — кнопка VIP-тарифа в Mini App (ProgramTab/TurnirProgramTab/WelcomePage/ResultsTab — все через `onVipClick`)
- `clients.partner_landing_url` — партнёрский сервис клиента (url-кнопка в боте, миграция 105)

**Стандартный набор параметров** (только непустые значения; имена жёстко зафиксированы для GetCourse/Tilda/Bizon360 — клиент один раз настраивает скрытые поля):

| Параметр | Что |
|---|---|
| `pluson_contact_id` | `contacts.id` (наш ID контакта в ПЛЮСОНе) |
| `pluson_participant_id` | `event_participants.id` (только для событий) |
| `tg_id` | Telegram user ID |
| `vk_id` | VK user ID |
| `email` | `contacts.email` |
| `phone` | `contacts.phone` |
| `name` | `contacts.name` |
| `tg_nickname` | username из platform_users (без @) |
| `pid` | реф-код того, кто привёл (для совместимости) |
| `utm_source` | UTM-метка источника |
| `event_slug` | slug события (только для events.landing_url и vip_url) |
| `{external_ref_param}` | партнёрский код во внешней системе клиента (например `gcpc=fdd97`) — приклеивается как есть, в конец URL |

**Хелперы** ([backend/app/services/external_landing.py](backend/app/services/external_landing.py)):
- `enrich_external_url(url, *, ...)` — собирает URL с полным набором параметров. Универсальный.
- `get_contact_landing_params(db, contact_id)` — асинх. подтягивает name/email/phone/tg_id/vk_id/tg_nickname/external_ref_param контакта.
- `build_external_landing_url(...)` — обратная совместимость для events landing.

**Endpoints для Mini App:**
- `GET /api/v1/public/events/{slug}/landing-redirect?tg_id=&vk_id=&pid=&utm_source=` → `{redirect_url}`. Используется для events.landing_url.
- `GET /api/v1/public/events/{slug}/vip-redirect?tg_id=&vk_id=&pid=&utm_source=` → `{redirect_url}`. Используется для events.vip_url.

**Webhook** ([backend/app/api/integrations.py](backend/app/api/integrations.py)) принимает алиасы: `pluson_contact_id` (стандарт), `pluson_cid` (legacy), `contact_id` (явный) — все мапятся в `data.contact_id`. То же для `pluson_participant_id` → `participant_id`.

**Партнёрский сервис** ([backend/app/services/partner_service.py](backend/app/services/partner_service.py) `_build_partner_landing_url`) использует общий `enrich_external_url` — на партнёрский лендинг шлёт `external_ref_param` РЕФОВОДА (это его код), не свой.

**Произвольные флаги `_q{key}` для активации блоков на стороннем лендинге (2026-05-25).** К стандартному набору можно добавить произвольные «маркеры тарифа» — например, чтобы в Tilda/GetCourse показывался скрытый блок при наличии `?shpw` в URL.

| Откуда приходит флаг | Формат прямой ссылки | Что попадает на лендинг |
|---|---|---|
| TG (прямая ссылка) | `t.me/{bot}?start=ref_pg{slug}_qshpw_qvip` | `&shpw=1&vip=1` |
| VK Mini App | `vk.com/app{aid}#ref_pg{slug}_qshpw` | `&shpw=1` |
| MAX | `max.ru/{handle}?startapp=ref_pg{slug}_qshpw` | `&shpw=1` |
| Веб-вход | `pluson.ru/l/{slug}?shpw` (или `?app=tg&shpw`) | `&shpw=1` (либо `_qshpw` в startapp при `?app=tg`) |

Алфавит ключа `[a-z0-9-]`, длина 1..16, до 5 флагов на один URL. Лишнее или несоответствие — тихо игнорируется. Значения не передаются — это всегда `=1`. Если нужно полноценное `key=value` — используйте `utm_source` или `external_ref_param`.

Хелперы и точки кода: `normalize_landing_flags` + параметр `flags=` в `enrich_external_url` ([external_landing.py](backend/app/services/external_landing.py)); CSV-параметр `?q=shpw,vip` на эндпоинтах `/landing-redirect` и `/vip-redirect` ([client_profile.py](backend/app/api/client_profile.py)); парсер `_q…` в [`parseStartParam`](mini-app/src/App.tsx) (Mini App), [`parse_startapp_ref_payload`](backend/app/services/max_auth.py) (MAX-бэк), inline-скрипт [index_tg.html](mini-app/index_tg.html), [redirect_web_app.js](web/public/redirect_web_app/redirect_web_app.js) (веб-вход).

### Регистрация партнёра клиента через сторонний лендинг (миграция 105 от 2026-05-24)

**Суть.** Самостоятельная фича — не привязана к событию или лид-магниту. Клиент в Настройках → Технические вписывает URL стороннего партнёрского сервиса (Tilda/GetCourse/Bizon360/любой), получает 3 **прямые** «корневые» ссылки + 3 **прямые** «ссылки возврата» (только TG/VK/MAX — email сюда не входит, нет интерактивности бота). Человек кликает корневую ссылку → попадает в бот платформы → бот шлёт сообщение с **обычной url-кнопкой** → лендинг открывается в браузере с уже подставленными `pluson_cid` (наш `contact_id`) и хвостом query-строки рефовода (его `external_ref_param`). После сабмита формы партнёрский сервис редиректит на «ссылку возврата» — `t.me/{bot}?start=partner_done_{client_id}` / `vk.me/{group}?ref=partner_done_{client_id}` / `max.ru/{handle}?start=partner_done_{client_id}` (без плейсхолдеров). Бот по своему `tg_id` / `vk_id` находит контакт у клиента, проверяет `contacts.external_ref_param` и шлёт сообщение «✅ Вы зарегистрированы, ваш код XXX» или «😕 Упс, что-то не так». У каждого зарегистрированного партнёра в карточке контакта появляются персональные **прямые** ссылки для распространения, в которых закодирован его `contact_id`.

**⚠️ Только прямые ссылки на платформы — никогда через прокси `pluson.ru/partner/...`** (см. [memory/project_direct_platform_links.md](memory/project_direct_platform_links.md) — общее правило для всех share-ссылок проекта).

**Mini App не используется** — ни для открытия лендинга, ни для экрана успеха. Всё происходит через сообщения бота + обычный браузер.

**БД (миграция 105):**
- `clients.partner_landing_url TEXT NULL` — URL стороннего лендинга. NULL = фича выключена (ссылки в карточках контактов замылены).
- `partner_runs (id, client_id, platform_slug, referrer_contact_id NULL, referrer_query TEXT DEFAULT '', contact_id NULL, stage, landed_at, opened_in_bot_at, opened_landing_at, completed_at)` — трекинг для аналитики. Стадии: `landed → opened_in_bot → completed`.

**Прямые ссылки клиента — формат start/ref:**

| Сценарий | Где формируется | Формат (TG: start, VK/MAX: ref) |
|---|---|---|
| Корневая ссылка клиента (без рефовода) | UI: Настройки → Технические | `prtc_{client_id}` |
| Личная ссылка партнёра | UI: карточка контакта | `prtp_{contact_id}` (бот резолвит client_id + external_ref_param через `contacts`) |
| Возврат после сабмита формы | UI: Настройки → Технические (ссылка возврата) | `partner_done_{client_id}` |

Бот по start-параметру / ref создаёт `partner_run` записи сам (`partner_service.start_partner_flow` / `start_partner_flow_vk`).

**Legacy endpoint (deprecated, для уже разосланных старых ссылок):** `GET /partner/{client_id}?to=tg|vk|max[&pluson_cid][&{erp_part}]` — 302 в бот со start=`prt_{run_id}`. Боты понимают `prt_<run_id>` параллельно с новыми `prtc_/prtp_`.

**Сообщения в боте** ([backend/app/services/partner_service.py](backend/app/services/partner_service.py)):

| Когда | Функция | Сообщение |
|---|---|---|
| /start prtc_<cid> / prtp_<contact_id> (TG), новый партнёр | `start_partner_flow` → `run_started_partner` | «Вы регистрируетесь Партнёром у {owner} ({brand}) 🎉» + **url-кнопка** «Открыть форму регистрации» (URL = `partner_landing_url + ?pluson_cid={new_id}&{referrer_query}`, полностью собран на сервере) |
| то же, уже партнёр | то же | «Вы уже партнёр у {brand}. Ваш код: XXX. По вопросам — @{work_tg}» (без кнопки) |
| /start partner_done_<cid> (TG) | `send_partner_done_tg` | «✅ Вы зарегистрированы, ваш код: XXX. Чтобы отслеживать — @{work_tg}» если код есть; «😕 Упс, наша система не получила ваш партнёрский код. Напишите @{work_tg}» если нет |
| ref=prtc_/prtp_ (VK) | `start_partner_flow_vk` → `run_started_partner_vk` | VK-аналог TG |
| ref=partner_done_<cid> (VK) | `send_partner_done_vk` | VK-аналог TG |
| /start prt_<run_id> (TG/VK, legacy) | `run_started_partner` / `_vk` | Для уже разосланных ссылок старого формата |

**Webhook** ([backend/app/api/integrations.py](backend/app/api/integrations.py)) — принимает `pluson_cid` как алиас `contact_id`. Когда форма заполнена, GetCourse/Bizon360 шлёт нам `{pluson_cid, external_ref_param}` → мы обновляем `contacts.external_ref_param` нужного контакта.

**TG bot** ([backend/bot/handlers/start.py](backend/bot/handlers/start.py)): обработчики `/start prt_<run_id>` и `/start partner_done_<client_id>`.

**VK consumer** ([backend/bot/vk_main.py](backend/bot/vk_main.py)) — общий хелпер `_extract_ref_with_prefix(event, prefix)` извлекает `prt_<n>` или `partner_done_<n>` из `ref` любого источника (`message.ref`, `payload.ref`, `event.ref`, `ref_source`). Подхватывается в `handle_message_allow` (первое сообщение от подписчика) и `handle_message_new` (если уже подписан).

**Auth /me** отдаёт `bot_handles: {telegram, vk, max}` (никнеймы клиентского бота/сообщества, или null если у клиента нет своего канала на платформе). UI использует это для построения «ссылок возврата» — на TG fallback на `@pluson_bot`, на VK/MAX без своего канала ссылка не показывается.

**UI** (только TG/VK/MAX — email сюда не входит, нет интерактивности бота):
- `/dashboard/settings` → вкладка «Технические» → блок **«Регистрация партнёров»**: поле URL + **3 прямые ссылки возврата** + **3 прямые корневые ссылки** для распространения. UI берёт `me.bot_handles` (TG handle для VIP-бота или fallback на `pluson_bot`, VK group handle, MAX handle) и собирает прямые URL.
- `/dashboard/clients` → карточка контакта → блок **«Партнёрская ссылка»**: если `clients.partner_landing_url` пуст → замыленные ссылки + «Сторонняя партнёрская ссылка не настроена». Иначе — 3 личные прямые ссылки `t.me/{bot}?start=prtp_{contact_id}` и аналогичные для VK/MAX. Бот по `contact_id` находит контакт → берёт его `client_id` и `external_ref_param` (партнёрский код этого контакта).
- Константа `PARTNER_PLATFORMS = ['telegram', 'vk', 'max']` в обоих компонентах. Email не показывается в партнёрке.

**nginx (dev и прод).** Добавлен 1 location: `^/partner/[0-9]+$` → FastAPI 8000.

**Поток «гость → партнёр» в круг.** Гость кликнул ссылку Маши (контакт #42, `external_ref_param='gcpc=fdd97'`) → бот создал гостю contact_id=N, сообщил «Вы регистрируетесь…» + кнопка на лендинг с `?pluson_cid=N&gcpc=fdd97` → юзер заполнил форму → GetCourse привязал свой партнёрский код к новому контакту → шлёт webhook с `pluson_cid=N&external_ref_param=gcpc=newcode` → бэк обновляет `contact[N].external_ref_param='gcpc=newcode'` → юзер вернулся в бот через `t.me/{bot}?start=partner_done_{client_id}` → бот по tg_id+client_id нашёл contact #N → увидел свежий код → ответил «✅ Вы зарегистрированы, ваш код gcpc=newcode». Теперь у Контакта N в его карточке появилась своя ссылка для распространения.

### Приветствие при открытии события (миграция 064 от 05.05.2026)

При каждом `event_start` из Mini App ([backend/app/api/event.py](backend/app/api/event.py)) бот клиента (или fallback `@pluson_bot`) шлёт пользователю **контекстное** сообщение с inline-кнопкой. Тип сообщения определяется автоматически:

| `kind` | Когда | Текст | Кнопка → |
|---|---|---|---|
| `register_cta` | `is_registered=false`, событие активно | «Добро пожаловать на «{title}» 🎉» + дата | «Зарегистрироваться» → `…?startapp=ref_pg{slug}` |
| `referral_reminder` | `is_registered=true`, не завершилось | «Вы ещё успеваете пригласить друзей…» | «Получить подарки» → `…?startapp=ref_pg{slug}_tabgame_pid{ref_code}` |
| `next_event_cta` | завершилось + у клиента есть ближайшее предстоящее опубликованное событие | «Спасибо за ваш интерес. Следующее: «{succ}» {дата}» | «Записаться на следующее» → `…?startapp=ref_pg{succ_slug}` |
| `ecosystem_thanks` | завершилось, у клиента ничего предстоящего | «Спасибо за ваш интерес. Заходите в Экосистему — там полезные материалы.» | «Открыть Экосистему» → `…?startapp=ref_pg{slug}_tabecosystem` |

«Следующее событие» определяется автоматически — поле `events.successor_event_id` не используется (удалено миграцией 065). Берём ближайшее по `start_at` опубликованное событие того же клиента, исключая текущее.

Завершение для конференций — `MAX(conf_days.day_date + close_time)` < сейчас МСК, для остальных — `events.end_at` или `status='ended'`.

**Дедуп — БД, не память.** В `event_participants` две колонки (миграция 064):
- `last_open_msg_kind TEXT`
- `last_open_msg_at TIMESTAMPTZ`

Логика: если новый `kind ≠ last_open_msg_kind` — шлём (статус сменился). Если совпадает — проверяем `broadcast_log` per `platform_user_id` контакта: если **после** `last_open_msg_at` были рассылки от бота клиента → наше сообщение «уехало вверх», шлём заново. Если рассылок не было — пропускаем.

Старый 5-минутный in-memory `_was_welcomed` удалён.

URL Mini App: для VIP — `https://t.me/{handle}` (бот клиента, без short-name), для общего — `https://t.me/pluson_bot/pluson` (с short-name `pluson`). Резолв `handle` — из `channels` per `client_id` (как в `tasks/broadcast.py`).

**Уведомление организатору о новом интересе на событие (12.05.2026).** В дополнение к сообщению самому пользователю, при **первом** создании `event_participants` (то есть человек впервые открыл событие через Mini App / реф-ссылку / landing-redirect) от `@pluson_bot` улетает сообщение в `clients.notifications_telegram_chat_id` — точно так же, как для лид-магнитов, только первая строка «Событие: <title>» вместо «Лид-магнит». Дедуп по факту вставки в `event_participants` (ON CONFLICT DO NOTHING + RETURNING id): повторные открытия того же события — молчат. Реализация — `_send_event_organizer_notification` в [event_welcome.py](backend/app/services/event_welcome.py).

### Авто-редирект внутри Mini App webview на iOS (рецепт)

Если из Mini App нужно автоматически (без клика) перебросить webview
на внешний URL — **только** через `window.location.replace(url)` (или
`.href`), **не** через `Telegram.WebApp.openLink` или `window.open`.
iOS блокирует второе как popup без user-gesture.

Полный recipe с готовым кодом, минимальным backend-endpoint и обработкой
возврата (флаг в startapp + защита от петли) — в
[documentation/MINI-APP-WEBVIEW-REDIRECT.md](documentation/MINI-APP-WEBVIEW-REDIRECT.md).
В этом проекте применяется в [mini-app/index_tg.html](mini-app/index_tg.html) для
авто-перехода на сторонний лендинг клиента (`events.landing_url`) до
рендера React-бандла.

### Лендинг события — единое поле `events.landing_url` + welcome-экран (миграция 057 от 04.05.2026)

**Лендинг для всех типов событий** (мероприятие, конференция, и т.д.) хранится в одном поле `events.landing_url`. Это «URL стороннего лендинга клиента» — Tilda, GetCourse, Taplink, самописный на Vercel и т.п. Если поле заполнено, Mini App показывает лендинг клиента вместо встроенной страницы события.

**Что удалено:**
- `conf_conferences.registration_url` — DROP, дублировало `events.landing_url`. Данные перенесены автоматически.
- В шаблонах рассылок `broadcast_templates.text` / `button_url` плейсхолдер `{registration_url}` заменён на `{landing_url}`. Backend ([message_builder.py](backend/app/services/message_builder.py)) поддерживает оба плейсхолдера для совместимости со старыми шаблонами клиентов.
- Pydantic-модель `ConferenceUpdate` без `registration_url`.

**Дашборд** ([ExternalLandingBlock.tsx](web/src/components/ExternalLandingBlock.tsx)) — общий компонент для карточки мероприятия и конференции:
- Заголовок «Подключение стороннего лендинга»
- Поле URL
- Готовая ссылка для клиента: `https://t.me/pluson_bot/pluson?startapp=ref_pg{slug}_reg` (с кнопкой копирования) — клиент вставляет эту ссылку в редирект после успешной регистрации в своём конструкторе. Тогда после заполнения формы человек возвращается в Mini App с флагом `_reg`.

**Mini App** — флаг `_reg` в startapp:
- [App.tsx](mini-app/src/App.tsx) парсит `regFromLanding`
- [EventPage.tsx](mini-app/src/pages/EventPage.tsx) при `regFromLanding=true && !is_registered` автоматически вызывает `/participants/register` без email/phone (данные у клиента, мы их пока не знаем — webhook от клиента отдельная фича на будущее)

**Welcome-экран как отдельная вкладка «Интро»** ([WelcomePage.tsx](mini-app/src/components/WelcomePage.tsx)):
- Колонка `event_participants.welcomed_at TIMESTAMPTZ NULL` помечает что человек уже видел экран
- Welcome — **отдельная вкладка** «Интро» в нижней навигации (первая, с иконкой checkmark в круге). Показывается зарегистрированному с `welcomed_at IS NULL` и автоматически открыта по умолчанию.
- Содержит: поздравление, кнопку «Войти в чат» (если `event.chat_url` заполнен), плитки с объяснением вкладок Программа/Игра/Розыгрыш/Экосистема, кнопку «Перейти к программе»
- При уходе с вкладки «Интро» на любую другую — POST `/api/v1/participants/{id}/welcomed` ставит `welcomed_at = now()`, вкладка **исчезает** из навигации навсегда (`filterByEnabled` фильтрует welcome по `welcomed_at`).
- Не показываем повторно — только сразу после первой регистрации.

### Возврат с лендинга — один webview через /r/{slug} (05.05.2026)

**Проблема:** клиент в редирект после регистрации на Tilda/GetCourse ставил `t.me/.../?startapp=ref_pg{slug}_reg`. iOS перехватывал t.me как universal link → Telegram открывал **новое** Mini App окно поверх старого webview с лендингом → у юзера фантом-окно (закрывает Mini App, попадает на «висящий» лендинг).

**Решение:** промежуточная Next.js-страница [`/r/[slug]/page.tsx`](web/src/app/r/[slug]/page.tsx). Клиент в редирект ставит `https://pluson.ru/r/{slug}` ВМЕСТО t.me-ссылки. Эта страница:
1. Загружается **в том же webview** (не t.me universal link → нет нового окна)
2. Имеет доступ к `Telegram.WebApp` (объект инжектится при открытии webview как Mini App, переживает навигацию)
3. POST `/participants/register` с tg_id из `initDataUnsafe.user.id` + опциональными email/phone/имя из query
4. `window.location.replace('/tg/event/{slug}')` — Mini App в **том же** webview → видит `welcomed_at IS NULL` → автоматически открывает «Интро»

**Поддерживаемые query-параметры** (опционально, для передачи данных регистрации без webhook):
```
https://pluson.ru/r/{slug}?email={email}&phone={phone}&first_name={first_name}&last_name={last_name}&pid={partner_id}&utm_source={utm}
```
GetCourse/Tilda сами подставляют `{email}` и т.п. при редиректе. Если параметры не переданы — регаемся по `tg_id` без email/phone (контакт без них).

**Fallback:** если `Telegram.WebApp` недоступен (страница открыта в обычном браузере) — `/r/{slug}` редиректит на `t.me/pluson_bot/pluson?startapp=ref_pg{slug}_reg` (старое поведение, два окна). Срабатывает только в edge-кейсе.

**Где документировано клиентам:** дашборд → событие → «Подключение стороннего лендинга» ([`ExternalLandingBlock.tsx`](web/src/components/ExternalLandingBlock.tsx)).

**ВАЖНО:** не использовать в новых фичах редирект клиента напрямую на `t.me/.../?startapp=..._reg` — только через `/r/{slug}`. Подробности — [memory/project_landing_return_one_webview.md](memory/project_landing_return_one_webview.md).

### Этапы программы — опциональный уровень над днями (миграция 093 от 2026-05-21)

Конференция и турнир получили опциональную группировку дней в этапы. Структура иерархическая: **Этап → День → Сессия**, плюс «боковая» ось «Залы» в БД (в UI пока не используется).

**Таблицы:**
- `conf_stages (id, event_id, sort_order, title, subtitle, description, start_date, end_date)` — этапы программы. Применяется в основном для турниров: «Предстарт» (2 недели, без детализации по дням), «Основной этап» (с программой по дням и спикерам).
- `conf_days.stage_id` (FK на `conf_stages`, ON DELETE SET NULL) — к какому этапу принадлежит день. NULL = «свободный» день вне группировки (как все существующие записи).
- `conf_days.title` — кастомное имя дня, fallback на «День N» по `day_number`.
- `conf_tracks (id, event_id, sort_order, title, color, stream_url, description)` — залы события (параллельные потоки). Заведены в БД для будущей фичи «параллельные залы внутри дня»; в UI ничего не отображается.
- `conf_sessions.track_id` (FK на `conf_tracks`, SET NULL) — сессия привязана к залу. NULL = общий зал.

**Где НЕ показывается интерфейс этапов** — в дашборде **конференций** (`/dashboard/conferences/[id]` → таб «Программа») рендерится старый `ProgramTab.tsx` без изменений. Только для модуля `turnir` (path `/dashboard/tournaments/[id]`) рендерится новый `TournamentProgramTab.tsx` с трёхуровневой иерархией Этап → День → Сессия.

**Mini App:** `TurnirProgramTab.tsx` грузит этапы через `GET /api/v1/events/{id}/conference/stages/public`. Если этапы есть — дни группируются под заголовками этапов (с диапазоном дат, описанием и подписью типа «2 недели»). Если этапов нет — плоский список дней, как раньше. Поле `conf_days.title` используется в подписи дня (fallback «День N»).

**API:** CRUD `/api/v1/events/{event_id}/conference/stages` (GET/POST/PATCH/DELETE). Эндпоинт `/conference/program-public` отдаёт целиком дерево `{ stages, days, sessions }` для Mini App. `/conference/days` (PUT) принимает `stage_id` и `title`. `/conference/sessions` (POST/PATCH) принимает `track_id`.

### Время программы — строки "HH:MM" + " МСК" везде (миграция 048 от 28.04.2026)

Чтобы убрать сдвиги часовых поясов в Mini App / веб / рассылках, время программы хранится строкой "HH:MM" и считается МСК по соглашению.

**Поля:**
- `conf_days.open_time` / `close_time` — TEXT ("10:00" / "18:00") или NULL.
- `conf_sessions.start_time` / `end_time` — TEXT ("11:30" / "12:00") или NULL. Колонки `start_datetime` / `end_datetime` УДАЛЕНЫ. День сессии — поле `day` (INT) и/или JOIN на `conf_days`.

**Отображение:**
- Везде, где показывается время программы — приписывается " МСК": "11:30–12:00 МСК", "Встречаемся завтра в 12:00 МСК на День 2".
- Mini App ([ProgramTab.tsx](mini-app/src/tabs/ProgramTab.tsx), [LandingTab.tsx](mini-app/src/tabs/LandingTab.tsx), [SelectorEventsTab.tsx](mini-app/src/tabs/SelectorEventsTab.tsx)) и дашборд: для дат событий жёстко `timeZone: 'Europe/Moscow'` + " МСК" — никаких `toLocaleTimeString` без `timeZone`.
- Бэкенд ([message_builder.py](backend/app/services/message_builder.py), [conference.py](backend/app/api/modules/conference.py)) форматирует время через `_fmt_time(val)` — это просто `str(val)[:5]`, без `.strftime`/`.astimezone`.

**Под капотом для расчёта `fire_at` рассылок** ([broadcasts.py](backend/app/api/modules/broadcasts.py)) — хелпер `_msk_str_to_utc(day_date, "HH:MM")` собирает naive datetime, вычитает 3 часа и возвращает UTC. Это внутренняя кухня — пользователь видит только "HH:MM МСК".

**Валидация ввода**: хелпер `_normalize_hhmm` в [conference.py](backend/app/api/modules/conference.py) принимает "HH:MM" или ISO с временем, отсекает лишнее, валидирует через regex `^([01]\d|2[0-3]):([0-5]\d)$`.

### Афиши событий — только в `event_posters` (миграции 044, 046, 047)

Колонка `events.poster_url` **удалена** миграцией 044. Все афиши событий теперь живут только в таблице `event_posters` с ориентациями `square` / `horizontal` / `vertical`.

**Миграции 046 + 047 (28.04.2026)** — финальная зачистка. У `conf_conferences` ещё оставались легаси-колонки `poster_horizontal/vertical/square` (text[]-массивы), куда ошибочно писал фронт конференции. 046 перенесла оттуда данные в `event_posters` и почистила мёртвые URL `referalka.tinydaisy.dev` (наследие 044). 047 **удалила** эти три колонки. Фронт конференции переведён на `api.referralProgram.posters.*`, бэкенд (`message_builder`, `regenerate_landing_data`) читает только `event_posters`.

**Где взять афишу для отображения:**
```sql
(SELECT url FROM event_posters
   WHERE event_id = e.id
   ORDER BY CASE orientation
              WHEN 'square'     THEN 1
              WHEN 'horizontal' THEN 2
              WHEN 'vertical'   THEN 3
              ELSE 4
            END, sort, id
   LIMIT 1)
```

API всех эндпоинтов событий ([`backend/app/api/events.py`](backend/app/api/events.py), [`participants.py`](backend/app/api/participants.py), [`client_profile.py`](backend/app/api/client_profile.py)) возвращают это значение в поле `poster_url`. Фронт продолжает читать `event.poster_url` как и раньше.

**Загрузка афиш** — через `POST /api/v1/uploads` с `kind='event_poster'` и `poster_type` ∈ `square|horizontal|vertical`. Запись попадает в `event_posters`. Старая колонка `events.poster_url` миграцией перенесена в `event_posters` как `horizontal`.

### Афиши спикеров — двухуровнево, fallback `cse → collaborators`

Афиша спикера живёт в двух местах:
- `collaborators.poster_url` — **глобальная** афиша коллаборатора. Дефолт-полуфабрикат, виден везде, где он подключён, если не переопределён в событии.
- `conf_speaker_events.poster_url` — **per-event** афиша. Заполняется на странице спикера в дашборде конференции, если для этой конференции нужна своя версия (надпись «СПИКЕР», брендирование, надпись «ЖЮРИ» для премии и т.д.).

**Правило отображения везде:** `cse.poster_url || collaborators.poster_url` — per-event приоритетнее, fallback на глобальную. При добавлении коллаборатора в событие `cse.poster_url` остаётся `NULL` — никакого копирования файла или URL не происходит, fallback срабатывает на лету при чтении.

API:
- `GET /events/{id}/conference/speakers` ([`list_event_speakers`](backend/app/api/modules/conference.py)) возвращает три поля: `cse_poster_url` (per-event), `speaker_poster_url` (глобальная), `poster_url` (готовый fallback `cse_poster_url || speaker_poster_url`). Фронт может читать любое из них.
- `GET /speakers/{id}/send-to-telegram` и `GET /speakers/{id}/public` тоже алиасят колонки.
- В рассылках ([`message_builder.py`](backend/app/services/message_builder.py)) для `speaker_intro` и `5min_before` используется `COALESCE(cse.poster_url, c.poster_url) AS speaker_poster`.

**В превью рассылок** ([`broadcasts/templates/page.tsx`](web/src/app/dashboard/conferences/[id]/broadcasts/templates/page.tsx)) спикерская афиша подставляется только для шаблонов со спикером (`speaker_intro`, `5min_before`, `gift`). Дневные/событийные шаблоны (`day_*`, `pre_conf`, `2h_before_*`, `30min_before`) подставляют горизонтальную афишу события из `event_posters`, а не первого попавшегося спикера.

### Сортировка спикеров/жюри/организаторов — единая логика (с 2026-05-23)

Один порядок везде: Mini App (`ProgramTab` — лента вверху и список внизу), Celery (выдача подарков `day_end`, рассылка знакомства `speaker_intro`), дашборд (`SpeakersTab`, список соорганизаторов мероприятий).

**Группы** (`group_rank`, меньше = выше):
1. organizer
2. commercial jury
3. commercial headliner
4. commercial speaker
5. commercial general_partner
6. commercial partner
7. jury
8. headliner
9. speaker
10. general_partner
11. partner

**Внутри группы:**
- `referrals DESC` — все, кто перешёл по личной реф-ссылке этого человека для текущего события (`event_participants.referrer_ref_code = contacts.ref_code` коллаба, независимо от `is_registered`).
- `priority ASC` — меньше число = выше (как в `calcPriority` дашборда: `organizer=10`, `jury=15`, …, `partner=70`). Просто тай-брейкер.
- `id ASC` — финальный тай-брейкер.

Источник истины — [`backend/app/services/collaborator_sort.py`](backend/app/services/collaborator_sort.py) (`order_by_sql(tbl)`). Подставляется в `ORDER BY` четырёх SQL-запросов:
- `GET /events/{id}/conference/speakers` и `/speakers/public` ([conference.py](backend/app/api/modules/conference.py))
- `GET /events/{id}/collaborators` ([events.py](backend/app/api/events.py))
- `day_end` подарки спикеров ([message_builder.py](backend/app/services/message_builder.py))
- `speaker_intro` `generate_schedules` — порядок `fire_at` для рассылки знакомства ([broadcasts.py](backend/app/api/modules/broadcasts.py))

TS-копия группировки — `roleOrder` в [`broadcasts/templates/page.tsx`](web/src/app/dashboard/conferences/[id]/broadcasts/templates/page.tsx) (только для UI-превью, без `referrals`). При добавлении новой роли — править оба места.

⚠️ Поля `is_commercial BOOL DEFAULT FALSE` и `priority INT DEFAULT 60` живут в `event_collaborators` на dev/проде, но в репо нет миграции, которая их создаёт (применены прямой ALTER TABLE до фиксации). Если поднимаете БД с нуля — нужны вручную.

### Мини-кабинет спикера на pluson.ru — самообслуживание (миграция 104 от 2026-05-24, в разработке)

**Суть.** Спикер сам правит свои данные (фото, контакты, соцсети, тема, подарки, материал в базу знаний) на отдельном веб-лендинге `pluson.ru/speaker/<event_slug>`. **Это НЕ Mini App** — обычная веб-страница в Next.js, потому что спикер может передать ссылку+код **ассистенту**, и потому что в будущем тут же появится кабинет жюри (оценки участников).

**Поток:**
1. Margo в дашборде заводит коллаба + добавляет в событие. Минимум: Имя, Фамилия, один из личных никнеймов (TG/VK/MAX — хотя бы один обязателен).
2. Бэк резолвит ID платформы по никнейму через её API → ищет/создаёт `contacts` + `platform_users` → создаёт `collaborators` с `contact_id` → генерит `access_code` (8 симв, безопасный алфавит).
3. В дашборде на странице спикера: `access_code` под «глазиком» + кнопка «📋 Скопировать сообщение для спикера» (готовый текст с 3 invite-ссылками TG/VK/MAX + инструкцией).
4. **Margo шлёт это сообщение спикеру сама**, любым способом — спикера ещё нет в боте, поэтому автоотправки от нас нет.
5. Спикер кликает любую invite-ссылку → попадает в бот соответствующей платформы → бот определяет `platform_user_id` из update → парсит `spkinv_<access_code>` → апсертит `platform_users` если её ещё не было → шлёт в личку: код доступа + ссылку `https://pluson.ru/speaker/<event_slug>`.
6. Спикер открывает лендинг → выбирает свою фамилию из списка → вводит код → JWT-сессия 24ч → форма правки.

**БД (миграция 104):**
- `collaborators.access_code TEXT NOT NULL UNIQUE` (8 симв, авто-gen при INSERT, backfill для существующих).
- `collaborators.vk_url`, `collaborators.max_url` — публичные каналы спикера (по аналогии с `tg_channel_url`, `instagram_url`).
- `event_collaborators.knowledge_base_title`, `knowledge_base_url` — один материал в базу знаний на событие.
- `event_collaborators.show_topic_field` BOOL DEFAULT TRUE, `show_gift_after_speech_field` BOOL DEFAULT TRUE, `show_knowledge_base_field` BOOL DEFAULT FALSE.

**⚠️ ЖЁСТКИЕ ПРАВИЛА — не плодить дубли:**

1. **НИКАКИХ** `personal_vk_id`, `personal_vk_username`, `personal_max_id`, `personal_max_username` в `collaborators`. Личные аккаунты спикера на платформах = **ТОЛЬКО через `platform_users`** (через `collaborators.contact_id → contacts.id → platform_users(contact_id, platform_slug, platform_user_id, username)`).
2. Старые поля `collaborators.personal_tg_id`, `personal_tg_username`, `assistant_tg_username` — **рудимент**. Не использовать в новой логике, читать личный TG через `platform_users(platform_slug='telegram')`.
3. `collaborators.vk_url` / `max_url` — это **публичные каналы спикера** (его VK-сообщество, его MAX-канал). НЕ путать с личным VK/MAX.
4. **Тоггла `show_gift_raffle_field` НЕТ.** Видимость поля «Подарок для розыгрыша» определяется глобально через `event_raffle_settings.is_enabled`.
5. **Margo не может завести коллаба без личного никнейма** хотя бы на одной платформе — валидация на бэке.
6. **`collaborators.contact_id` остаётся NOT NULL.** Контакт создаётся одновременно с коллабом, никогда не позже.
7. **Код доступа общий на коллаба** (один `access_code` на все его события у клиента). Invite-ссылки **per-event** (в URL зашит `event_slug`).
8. **Бот** — клиентский VIP если есть подключённый канал на платформе, иначе системный (по аналогии с лид-магнитами).

**Связанные фичи того же запроса (миграция 104):**
- **4 кнопки соцсетей** в карточке спикера в Mini App — 2×2 с полным текстом (TG-канал / VK / MAX / Нельзяграм). Показываются только заполненные.
- **Отдельная вкладка «Спикеры»** в Mini App для конференций и турниров (станет 4-й вкладкой: Программа / Спикеры / Подарки / Экосистема [+ Розыгрыш]). Клик на сессию в Программе → переход на «Спикеры» + скролл к карточке (deeplink).
- **Иконка книжки** (SVG в нашем стиле, не эмодзи) для блока «Материал в базу знаний» под кнопками соцсетей в карточке спикера в Mini App.

**Будущее (не сейчас).** Тот же кабинет (`/speaker/<event_slug>/...`) расширится до:
- `/speaker/<event_slug>/grades` — оценки участников для жюри.
- `/speaker/<event_slug>/materials` — общая база знаний события глазами спикера.

Общий wrapper-layout с auth (JWT 24ч), внутри подстраницы. Архитектурно — это **мини-личный-кабинет спикера**, не одноразовая форма правки.

### Коллаб без личного аккаунта + псевдо-`platform_users` (2026-05-25)

**Личный аккаунт коллаба (TG/VK/MAX) — НЕ обязателен.** Бизнес-партнёры (компании FREEDOM/GRANI и т.п.) — это просто карточки на сайте, без рассылок. Поэтому валидация `has_personal` снята в `POST /collaborators` и `POST /collaborators/quick`. В UI формы создания коллаба — подсказка «Можно оставить пустым если бизнес-компания, рассылка по нему идти не будет».

**Username без числового ID → резолв → fallback на псевдо-запись.** [`_upsert_personal_identity`](backend/app/api/collaborators.py) при получении только `username` (без `user_id`):
1. Пробует резолвить `username → числовой id`:
   - **TG:** `getChat(@username)` через бот клиента (или системный @pluson_bot). Работает только если юзер уже писал боту — для незнакомых редко.
   - **VK:** `users.get?user_ids={screen_name}` через VK API — почти всегда срабатывает.
   - **MAX:** пока без публичного API — всегда fallback.
2. **Если резолв успешен:** `INSERT platform_users` с реальным id + проверка подписки (`getChatMember` / `groups.isMember`) → `platform_user_channels.is_unsubscribed = !is_subscribed`.
3. **Если резолв НЕ удался:** `INSERT platform_users (platform_user_id = '@<username>', username = ...)` — **псевдо-запись**. Префикс `@` гарантирует что не пересечётся с реальными числовыми id (real id — всегда int64). `platform_user_channels.is_unsubscribed=TRUE` — рассылки не идут пока коллаб реально не появился.

**При первом сообщении коллаба в бот — апдейт псевдо-записи** ([`upsert_contact_with_identity`](backend/app/services/contact_merge.py)):
1. Стандартный поиск по числовому `platform_user_id` → не нашёл.
2. Если в update есть `username` — поискать псевдо-запись `WHERE client_id=$1 AND platform_slug='telegram' AND platform_user_id='@'||$username`.
3. Если псевдо нашлась → `UPDATE platform_users SET platform_user_id = реальный_id, username = ...` + `UPDATE platform_user_channels SET is_unsubscribed=FALSE` (юзер подписался реально). Контакт остаётся тот же — коллаб привязан, дублей нет.

**Uniqueness по username:** при INSERT с псевдо-id `@username` — проверка что у клиента нет другой `platform_users` записи с таким же `username` на этой платформе. Если есть — 400 с пояснением.

Подробнее в memory: [project_collaborator_pseudo_platform_users.md](../../.claude/projects/-Users-macbookair-Documents-projects-referalka/memory/project_collaborator_pseudo_platform_users.md).

### Медийные активы коллаборатора + JSON-эндпоинты для сторонних лендингов (миграция 111 от 2026-05-25)

**Зачем.** Клиент верстает свой лендинг события (Tilda, GetCourse, AI-сгенерированный HTML на Vercel и т.п.) и хочет автоматически подтягивать данные коллабораторов и программу из ПЛЮСОНа — фото, регалии, должность, медийные активы, расписание. Это решается двумя публичными JSON-эндпоинтами с открытым CORS.

**Поле `collaborators.media_assets JSONB`** — массив объектов `[{platform, subscribers}]`. Платформы фиксированы (CHECK на тип array): `tg / youtube / vk / tiktok / instagram / max / rutube`. По одной записи на платформу — комбо в UI не даёт выбрать уже использованную. Редактируется в:
- Дашборде → карточка коллаба `/dashboard/collaborations/[id]` — блок «Медийные активы» (компонент [`MediaAssetsField`](web/src/components/MediaAssetsField.tsx)), сохраняется через `PATCH /api/v1/collaborators/{id} { media_assets }`.
- Мини-кабинете спикера `/speaker/<event_slug>` — секция «Медийные активы», сохраняется через `PATCH /api/v1/public/speaker-cabinet/me { media_assets }`.

Хелпер нормализации `_normalize_media_assets` в [collaborators.py](backend/app/api/collaborators.py) — фильтрует неизвестные платформы и неотрицательные целые, переиспользуется из self-service.

**Публичные эндпоинты для сторонних лендингов** ([backend/app/api/landing_widget.py](backend/app/api/landing_widget.py)) — префикс `/api/v1/public/landing-widget/`. CORS открыт для `*` через ручные заголовки в Response (не через `CORSMiddleware`, который сконфигурирован с `allow_credentials=True` несовместимо с `*`-origin); preflight-OPTIONS зарегистрирован отдельно.

1. **`GET /events/{slug}/collaborators`** — плоский список всех коллабораторов события, сгруппированный по 4 ключам:
   - `organizers` — `role=organizer`
   - `jury` — `role=jury`
   - `speakers` — `role IN (speaker, headliner)`
   - `partners` — `role IN (general_partner, partner)`

   Карточка содержит: `id, collaborator_id, name, title, position, photo_url, poster_url` (fallback `cse.poster_url || c.poster_url`), `achievements, role, is_commercial, topic, sort_order, tg_channel_url, vk_url, max_url, instagram_url, website_url, media_assets, knowledge_base_title, knowledge_base_url, ref_code`.

   **Сортировка внутри группы — БЕЗ приоритета `is_commercial`** (по запросу клиента — коммерческие не выносятся вперёд в выдаче для лендингов): `group_rank (organizer < jury < headliner < speaker < general_partner < partner) → referrals DESC → priority ASC → id ASC`. Логика SQL — внутри файла [`landing_widget.py`](backend/app/api/landing_widget.py), не в общем `collaborator_sort.py` (там остаётся версия с коммерческими приоритетами для Mini App / дашборда).

2. **`GET /events/{slug}/program`** — `{ stages, days, sessions }`. В каждой сессии `speaker: { id, name, title, photo_url, achievements, tg_channel_url, vk_url, max_url, instagram_url, website_url, media_assets } | null`. Время — строки `HH:MM` (см. правило «Время программы — строки HH:MM»).

Пример использования на лендинге — `fetch('https://pluson.ru/api/v1/public/landing-widget/events/{slug}/collaborators').then(r => r.json())` → рендер через свою вёрстку. `Cache-Control: 60s` (изменение в дашборде → автообновление лендинга в течение минуты).

### Описание события — единое поле `events.description` для всех типов (миграция 092 от 2026-05-21)

У события два независимых поля описания, оба живут на уровне `events` (не в `conf_conferences`):

- `events.description` — **«Описание для лендинга»** (продающий текст). Показывается на встроенном лендинге Mini App ([LandingTab.tsx](mini-app/src/tabs/LandingTab.tsx)) до регистрации и в превью рассылок как `{conf_description}`.
- `events.description_post_register` — **«Описание после регистрации»** (инструкции «что делать дальше»). Показывается в Mini App на вкладке «Программа»/«Турнир»/«Конкурс» под плитками стрима и чата ([ProgramTab.tsx](mini-app/src/tabs/ProgramTab.tsx), [TurnirProgramTab.tsx](mini-app/src/tabs/TurnirProgramTab.tsx), [ContestProgramTab.tsx](mini-app/src/tabs/ContestProgramTab.tsx)).

Правило едино для всех `module_slug` (`base`, `conference`, `turnir`, `contest`, ...). До миграции 092 для конференций/турниров «Описание для лендинга» ошибочно сохранялось в `conf_conferences.description`, которое Mini App не читает — отсюда баг «на лендинге показывается описание после регистрации».

**Миграция 092:** перенесла `conf_conferences.description → events.description` (только там, где `events.description` пустое или совпадало с `description_post_register` после копирования миграции 084 — т.е. legacy-значение), потом дропнула колонку `conf_conferences.description`. Поле `description` убрано из `ConferenceUpdate` (Pydantic). В `regenerate_landing_data` и в плейсхолдерах `{conf_description}` шаблонов рассылок (`pre_conf`, `custom`) теперь берётся `events.description`. В `SettingsTab` конференций/турниров поле «Описание для лендинга» сохраняется через `PATCH /events/{id} { description }` вместе с остальными `events`-полями.

**HTML-разметка в описаниях (с 2026-05-21).** Оба поля поддерживают пользовательский HTML. В Mini App рендер идёт через общий компонент [`EventDescription`](mini-app/src/components/EventDescription.tsx): если строка содержит HTML-теги — прогоняется через [`sanitizeHtml`](mini-app/src/utils/htmlSanitize.ts) (allowlist: `<p>/<br>/<b>/<strong>/<i>/<em>/<u>/<s>/<a>/<ul>/<ol>/<li>/<h2>/<h3>/<h4>/<blockquote>/<span>/<div>/<hr>`, атрибуты только `href/target/rel` на `<a>`, схемы URL — `http/https/mailto/tel`, иначе атрибут срезается); иначе — старый рендер plain-текста с `whiteSpace: pre-wrap` (для конкурсов сверху ещё `linkify()` http-ссылок). На бэке для Telegram-рассылок (`{conf_description}` в шаблонах `pre_conf`/`custom`) HTML конвертируется в Telegram-совместимый формат через [`html_to_telegram`](backend/app/services/message_builder.py) (`<br>` → `\n`, `</p>` → `\n\n`, `<li>` → `• `, `<h*>` → `<b>…</b>\n\n`, прочие блочные — удаляются; inline-теги `<b>/<i>/<u>/<s>/<a>` Telegram парсит как есть). Это обязательно — без конвертации Telegram отвечает `can't parse entities` и сообщение не уходит.

### Статус событий и даты конференций (миграция 043 от 28.04.2026)

**Статусы `events.status`:**
- `draft` — черновик, в Mini App не показывается. Дефолт для новых и копированных событий.
- `published` — опубликовано, видно в Календаре Хаба и на лендинге (`GET /api/v1/public/clients/{id}/events` фильтрует `status IN ('published','ended')`).
- `ended` — завершено.

В дашборде в шапке карточки события и карточки конференции — кнопка-чип «Черновик / Опубликовано» ([`web/src/components/EventStatusToggle.tsx`](web/src/components/EventStatusToggle.tsx)). Клик переключает через `PATCH /api/v1/events/{id} { status }`.

**Даты конференций — источник истины это программа (`conf_days`).**

Для событий с `module_slug = 'conference'` поля `events.start_at` / `events.end_at` НЕ используются и НЕ выставляются в UI. Mini App и лендинг (`/api/v1/public/clients/{id}/events` и `/api/v1/public/events/{slug}/landing` в [`backend/app/api/client_profile.py`](backend/app/api/client_profile.py)) для конференций берут:
- `start_at = MIN(day_date + open_time)` из `conf_days` (timezone Europe/Moscow)
- `end_at  = MAX(day_date + close_time)` из `conf_days`

Для остальных модулей (`base`, `webinar` и т.д.) даты — собственные `events.start_at` / `events.end_at`.

При копировании события (`POST /events/{id}/copy`) `start_at`/`end_at` копии = `NULL`, статус = `draft`.

### Ассистент клиента — один помощник на клиента (миграция 106 от 2026-05-24)

Клиент может подключить **одного** ассистента с урезанным доступом в свой кабинет. Ассистент входит на общий `/login` через свой email+пароль, в JWT получает `role='assistant'` и `sub=client_id` владельца — работает в том же кабинете, но middleware блокирует опасные действия.

**Таблица `client_assistants`** (id, client_id UNIQUE, email UNIQUE, password_hash, **password_plain**, last_login_at, created_at, updated_at). `password_plain` хранится в открытом виде специально — клиент в `/dashboard/settings` → вкладка «Ассистент» видит пароль под иконкой-глазиком и может переслать ассистенту повторно. Сознательный trade-off безопасности ради UX.

**API ассистента** ([backend/app/api/assistants.py](backend/app/api/assistants.py)) — все только для роли `owner` (не для `assistant`):
- `GET /api/v1/clients/me/assistant` — текущий ассистент (без пароля)
- `GET /api/v1/clients/me/assistant/password` — открытый пароль (для глазика)
- `POST /api/v1/clients/me/assistant {email}` — генерит 12-символьный пароль (алфавит без 0/o/1/l/I), шлёт ассистенту письмо через системный email-канал ПЛЮСОНа, возвращает `{email, password}`. Защита от коллизии email с clients/admins/другими assistants.
- `POST /api/v1/clients/me/assistant/reset-password` — генерит новый пароль и шлёт письмо
- `DELETE /api/v1/clients/me/assistant` — полное отключение

**Логин ассистента** ([auth.py:login](backend/app/api/auth.py)) — поиск идёт в порядке `clients → client_assistants → admins`. JWT при успехе: `{sub: str(client_id), email: assistant_email, role: 'assistant', assistant_id}`.

**`GET /auth/me`** возвращает дополнительное поле `role: 'owner'|'assistant'`. Для ассистента подменяется `email` на email самого ассистента (чтобы в шапке отображался он, а не владелец) и добавляется `assistant_id`. Поле `name` остаётся именем клиента-владельца.

**Матрица прав ассистента — финальная (2026-05-24):**

| Раздел | Что может |
|---|---|
| **Контакты, коллабораторы** | GET + PATCH (правка имени/email/телефона). DELETE — 403. |
| **События** | GET, PATCH, POST (создание/редактирование). DELETE самого события — 403. |
| **Участники события** | GET, PATCH (галка регистрации). DELETE — 403. |
| **Соорганизаторы события + спикеры конференции** | GET, PATCH (флаги/порядок). DELETE привязки к событию — 403. |
| **Подарки события (`event_gifts`)** | GET + PATCH/POST. DELETE — 403. |
| **Реф-программа (пороги, материалы, тексты шеринга, афиши)** | **Полный доступ включая DELETE** — это редактирование контента, не «человеческое» удаление. |
| **Рассылки (шаблоны, расписания, общие + в событиях)** | **Полный доступ включая DELETE.** |
| **Шаги nurture (приветствия)** | **Полный доступ включая DELETE.** |
| **Программа конференции (этапы, дни, сессии, треки)** | **Полный доступ включая DELETE.** |
| **Розыгрыш (призы, кодовые слова, билеты, победители)** | **Полный доступ включая DELETE.** |
| **Mini App: визитка бренда, основатель, продукты** | **Полный доступ включая DELETE продуктов.** |
| **Лид-магниты + пакеты** | Только GET + копирование ссылок (create/update/delete — 403). |
| **Каналы (боты)** | **Нет доступа** (UI скрыт, бэк 403 на любой метод). |
| **Настройки клиента + Подписка + Юр.данные** | **Нет доступа** (UI скрыт, бэк 403 на PATCH/POST). |
| **Управление ассистентами (`/clients/me/assistant`)** | 403 (ассистент не управляет сам собой). |
| **Будущие `/api/v1/billing`, `/api/v1/payments`** | 403 (middleware заложен на эти префиксы). |

**Middleware** [`assistant_permission_guard.py`](backend/app/middleware/assistant_permission_guard.py) — добавлен в `main.py` ПОСЛЕ `subscription_guard` (Starlette стек: последний добавленный исполняется первым → права отрабатывают до проверки подписки). Логика: декодит JWT, если `role != 'assistant'` → пропуск. Иначе:
1. **`FORBIDDEN_PREFIXES`** (любой метод) — `/channels`, `/clients/me/assistant`, `/billing`, `/payments`, `/admin`
2. **`READONLY_PREFIXES`** (только write блокируется) — `/lead-magnets`, `/lead-magnet-packages`
3. **`FORBIDDEN_WRITE_PATHS`** (точечно для write) — `/auth/me` (PATCH), `/auth/change-password`, `/auth/regenerate-integration-token`; **`FORBIDDEN_WRITE_PREFIXES`** — `/clients/me/legal`
4. **`FORBIDDEN_DELETE_PATTERNS`** (точечно для DELETE, регэкспы) — `/contacts/{id}`, `/collaborators/{id}`, `/events/{id}`, `/events/{id}/participants/{id}`, `/events/{id}/collaborators/{ec_id}`, `/events/{id}/gifts/{id}`, `/events/{id}/conference/speakers/{id}`

⚠️ Все остальные DELETE (внутри реф-программы, рассылок, программы конференции, розыгрыша, продуктов Mini App) — **разрешены**.

**Фронт.** Хук [`useMe()`](web/src/hooks/useMe.ts) — кеширует `/auth/me` в памяти модуля, отдаёт `{me, isAssistant, isOwner}`. Скрытые UI-элементы при `isAssistant=true`:
- [Sidebar.tsx](web/src/components/Sidebar.tsx) — пункты «Каналы» и «Настройки» убраны; добавлен бейдж «· ассистент» под именем
- [/dashboard/clients](web/src/app/dashboard/clients/page.tsx) — корзинка удаления контакта
- [/dashboard/collaborations](web/src/app/dashboard/collaborations/page.tsx) — корзинка коллаборатора
- [/dashboard/events](web/src/app/dashboard/events/page.tsx) — корзинки удаления события в обоих видах (list + grid)
- [/dashboard/events/[id]/tabs/CoOrganizersTab.tsx](web/src/app/dashboard/events/%5Bid%5D/tabs/CoOrganizersTab.tsx) — крестик отвязки соорганизатора
- [/dashboard/conferences/[id]/tabs/SpeakersTab.tsx](web/src/app/dashboard/conferences/%5Bid%5D/tabs/SpeakersTab.tsx) — корзинка удаления спикера
- [EventParticipants.tsx](web/src/components/EventParticipants.tsx) — корзинка удаления участника
- [/dashboard/lead-magnets](web/src/app/dashboard/lead-magnets/page.tsx) — кнопки «Добавить», «Редактировать», «Удалить» (read-only с копированием ссылок)
- В [/dashboard/settings](web/src/app/dashboard/settings/page.tsx) есть отдельная вкладка «Ассистент» ([AssistantTab.tsx](web/src/components/settings/AssistantTab.tsx)) — но она для owner; страница `/settings` целиком скрыта из сайдбара ассистента

**Глобальный UX-фоллбек на 403** в [api.ts](web/src/lib/api.ts) — если бэк вернул 403 с detail, начинающимся на «Ассистент» или равным «Этот раздел доступен только владельцу кабинета.», `request()` ПОМИМО throw показывает `window.alert(detail)` через setTimeout. Это страхует случаи когда вызывающий код не обернул запрос в try/catch — кнопка не «тихо» ничего не делает, а сразу объясняет почему.

⚠️ **GRANTы на проде и dev** после миграции 106: роль БД = `plusson` (не `plusson_user`). Команда:
```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON client_assistants TO plusson;
GRANT USAGE, SELECT ON client_assistants_id_seq TO plusson;
```

**Тестирование (e2e на dev, 2026-05-24):** create → пароль ✓; login as assistant → JWT role='assistant' ✓; DELETE /contacts/N → 403 ✓; GET /channels → 403 ✓; PATCH /auth/me → 403 ✓; POST /lead-magnets → 403 ✓; GET /lead-magnets → 200 ✓; GET /contacts → 200 ✓; GET /clients/me/assistant как assistant → 403 ✓; reset-password / get-password / delete — все ✓.

### Подписочная архитектура G (миграция 066 от 2026-05-07)

**Ключевое:** канал и привязка к клиенту — **разные сущности**. Один канал может обслуживать несколько клиентов (системные общие боты).

**`channels`** (БЕЗ `client_id`):
```
id | platform_slug | display_name | handle | bot_token | is_system | is_test
```
- `is_system=TRUE` — общий сервисный канал (`@pluson_bot`, в будущем MAX/VK).
- `is_test=TRUE` — системный канал в тестовом режиме (создан админом, но клиентам ещё не выдан). CHECK: `is_test=TRUE` только если `is_system=TRUE`.

**`client_channels`** — junction «канал доступен клиенту»:
```
id | client_id (FK) | channel_id (FK) | is_active
```
- UNIQUE (client_id, channel_id).
- `is_active=TRUE` — главный канал клиента на этой платформе. **Триггер** `enforce_one_active_per_platform` гарантирует один активный на (client × platform).

**`platform_user_channels`** — подписки в КОНКРЕТНОМ контексте:
```
id | platform_user_id (FK platform_users) | client_channel_id (FK) | is_unsubscribed | subscribed_at | unsubscribed_at
```
- Раньше ссылалось на `channel_id` напрямую — теперь через `client_channel_id`. Это даёт **явное разделение** подписчиков по клиентам без риска утечки между ними.
- ON DELETE CASCADE от `client_channels` — если клиента отвязывают от канала, его подписки автоматически уходят.

**Системный клиент в `clients`** (`name='ПЛЮСОН Сервис'`, `email='system@pluson.ru'`, `tariff_slug='beta'`) — для контактов которые пришли через `@pluson_bot` без контекста (`/start` без аргументов, реклама самого ПЛЮСОНа). Их `platform_users.client_id` указывает на этого системного клиента.

**Регистрация нового клиента** ([backend/app/api/auth.py](backend/app/api/auth.py)) — auto-INSERT в `client_channels` для всех боевых системных каналов:
```sql
INSERT INTO client_channels (client_id, channel_id, is_active)
SELECT $new_client_id, ch.id, TRUE
  FROM channels ch WHERE ch.is_system AND NOT ch.is_test;
```
Никаких ручных шагов.

**Активация системного канала из тестового в боевой** (admin-API `PATCH /admin/system-channels/{id} {is_test: false}`) — backfill `client_channels` всем существующим клиентам. Обратное — только если 0 подписок (иначе 409).

**Запреты в API клиента** ([backend/app/api/channels.py](backend/app/api/channels.py)):
- 403 на DELETE/PATCH `bot_token` для `is_system=TRUE` каналов.
- 403 на смену `display_name`/`handle` системных каналов.
- 403 на импорт CSV в системный канал (юзеры приходят сами через `/start`).
- 409 при DELETE канала с подписчиками (предупреждение, чтобы не потерять базу).

**UI клиента** ([web/src/app/dashboard/channels/page.tsx](web/src/app/dashboard/channels/page.tsx)):
- Системные каналы в списке — серая плашка «Системный» вместо кнопок Edit/Delete/Upload, с иконкой «?» и пояснением «управляется администратором ПЛЮСОНа, токен общий, удалить нельзя».

**UI админа** ([web/src/app/admin/system-channels/page.tsx](web/src/app/admin/system-channels/page.tsx)):
- CRUD системных каналов. Создание → всегда в тестовом режиме (`is_test=TRUE`). Перевод в бой (`is_test=FALSE`) автоматически делает backfill `client_channels` всем клиентам.

**Глобальная отписка при `my_chat_member kicked`** ([backend/bot/handlers/chat_member.py](backend/bot/handlers/chat_member.py)):
- Юзер заблокировал @pluson_bot → пометить `is_unsubscribed=TRUE` во ВСЕХ контекстах (по всем `client_channels` для этого канала). Бот реально заблокирован — никаким клиентом сообщения дойти не могут.
- `mark_unsubscribed_globally` / `resubscribe_globally` в [backend/app/services/channels.py](backend/app/services/channels.py).

**Один tg_id в нескольких контекстах** — норма. Один человек может попасть в БД как:
- `platform_users(client_id=Маргарита, tg=X)` — пришёл по реф-ссылке Маргариты
- `platform_users(client_id=Роман, tg=X)` — пришёл по реф-ссылке Романа
- `platform_users(client_id=системный, tg=X)` — пришёл через `/start` без контекста

И иметь по одной подписке в каждом контексте через `platform_user_channels(client_channel_id)` указывающие на разные `client_channels` записи.

**Смена ключевых SQL-запросов:**
- «Каналы клиента» → `JOIN channels ch ON ch.id=cc.channel_id WHERE cc.client_id=$1`
- «Подписчики клиента на канал N» → `JOIN client_channels cc ON cc.id=puc.client_channel_id WHERE cc.client_id=$1 AND cc.channel_id=$N AND puc.is_unsubscribed=FALSE`
- `_load_vip_tokens` в bot/main.py — JOIN на `client_channels` + `is_system=FALSE`
- `get_telegram_send_targets` в services/channels.py — JOIN на `client_channels`
- Импорт CSV — пишет `platform_user_channels` с `client_channel_id` найденным через `client_channels(client_id, channel_id)`.

### Тарифы и подписки клиентов (миграции 067-072 от 07.05.2026)

**Концепция.** Тарифы хранят только параметры (цена, лимиты, длительность). Опциональные модули («свой бот», «модуль Конференции», «экспорт контактов» и т.п.) — отдельные сущности (`features`), привязываются к тарифам через junction. Активность тарифа у клиента — отдельная запись (`client_subscriptions`).

**Таблицы:**
- `features (id, slug, name, description, sort)` — справочник опций. Сейчас 5 фич: `lead_magnets`, `conference`, `awards`, `channels`, `export_contacts`.
- `tariff_features (tariff_id, feature_id)` — many-to-many. Настройка состава тарифа = INSERT/DELETE строки, без миграций.
- `client_subscriptions (id, client_id, tariff_id, started_at, expires_at, status, source, notified_7d/3d/1d)` — подписки клиента. Status: `active|expired|paused`. Source: `paid|trial|admin|promo`.
- `clients.current_subscription_id` — денормализованный указатель на текущую подписку (для быстрого доступа в шапке UI).
- В `tariffs` колонки `contact_limit`, `broadcasts_daily_limit` (NULL=безлимит), `default_duration_days`. **Удалены:** `allow_custom_bot`, `trial_months`, `max_events`, `max_participants`.

**База** (всегда включено, не фичи): контакты, мероприятия, рассылки.

**Тарифы:**

| slug | Цена | Длит. | Контакты | Рассылки/сутки | Фичи поверх базы |
|---|---:|---:|---:|---:|---|
| `trial` | 0 ₽ | 60 дн | 10 000 | безлимит | все 5 |
| `start` | 990 ₽ | 30 дн | 1 000 | 10 000 | lead_magnets |
| `pro`   | 2 490 ₽ | 30 дн | 5 000 | 30 000 | lead_magnets, conference, awards |
| `vip`   | 3 900 ₽ | 30 дн | 10 000 | безлимит | все 5 |

**Три режима клиента:**
1. **Активна** — `cs.status='active' AND cs.expires_at > NOW()` — всё работает.
2. **Понижена** — клиент сам понизил тариф. Подписка active, но фич меньше. Утраченные фичи: read-only UI. Бот клиента: polling off (если фичи `channels` нет). Воронки → @pluson_bot. Рассылки по существующей базе **разрешены** (URL-кнопки работают без polling).
3. **Истекла** — `expires_at < NOW()` или `status='expired'`. Глобальный freeze. Просмотр интерфейса ОК. Любая запись/правка/экспорт — 403. Polling off. Будущие рассылки → `paused_subscription_expired`. **Grace-периода нет**, хард-катит ровно в `expires_at`.

**Backend компоненты:**
- [`app/services/features.py`](backend/app/services/features.py) — `client_has_feature(db, client_id, slug)`, `get_client_features(db, client_id)`.
- [`app/services/subscriptions.py`](backend/app/services/subscriptions.py) — `get_subscription`, `is_active`, `assert_active`, `expire_overdue`, `days_until_expires`.
- [`app/middleware/subscription_guard.py`](backend/app/middleware/subscription_guard.py) — глобальный middleware: 403 на write-запросы клиента при истёкшей подписке. Пропускает `/api/v1/auth/*`, `/admin/*`, `/public/*`, `/integrations/*`, `/participants/*`, `/event/*`, `/r/*`, `/m/*`, `/p/*`. GET всегда ОК.
- [`app/tasks/subscriptions.py`](backend/app/tasks/subscriptions.py) — Celery cron: `expire_overdue` (раз в час: помечает истёкшие, паузит будущие рассылки) и `notify_expiring` (раз в час: за 7/3/1 день шлёт через @pluson_bot, идемпотентность через `notified_7d/3d/1d`).
- [`app/tasks/broadcast.py`](backend/app/tasks/broadcast.py) — race-protection: перед `sendMessage` проверяет подписку, если истекла → `paused_subscription_expired`.

**Замена `allow_custom_bot` (5 мест):**

| Файл | Сейчас |
|---|---|
| `api/channels.py:_assert_can_use_custom_bot` | `client_has_feature('channels')` |
| `api/auth.py:get_me` | `me.features[]` + `me.subscription{status,expires_at,days_left,...}` |
| `api/participants.py` (селектор @pluson_bot) | NOT EXISTS подписки с фичей `channels` |
| `api/funnels.py` + `services/funnel_service.py` | `if 'channels' in features` |
| `bot/main.py:_load_vip_bots` | EXISTS подписки с фичей `channels` |

**Frontend компоненты:**
- [`SubscriptionBadge.tsx`](web/src/components/SubscriptionBadge.tsx) — бейдж в шапке дашборда: зелёный/жёлтый/красный по дням до истечения. Клик → `/dashboard/settings?tab=subscription`.
- [`SubscriptionBanner.tsx`](web/src/components/SubscriptionBanner.tsx) — крупный red banner при истёкшей подписке.
- `Sidebar.tsx` — пункт «Конференции» скрыт если нет фичи `conference`.
- `dashboard/settings/page.tsx` — вкладка «Подписка»: тариф, дата, состав фич, кнопка продления (через Telegram).
- `dashboard/channels/page.tsx` — `me.features.includes('channels')` вместо `me.allow_custom_bot`.
- `admin/clients/page.tsx` — статус подписки + бейджи фич.
- `admin/tariffs/page.tsx` — форма с `contact_limit/broadcasts_daily_limit/feature_slugs`.

**Уведомления.** За 7/3/1 день до истечения — сообщение в `clients.notifications_telegram_chat_id` через @pluson_bot. Триггер — Celery beat (`notify-expiring-subscriptions`, раз в час). Идемпотентность — флаги `notified_7d/3d/1d` на подписке.

**Существующие клиенты на проде и dev** (на момент миграции — 2 шт):
- ID 1, Маргарита Форбс (`vip`, trial_ends_at=2027-03-18) → подписка VIP до 2027-03-18, source=paid.
- ID 3, ПЛЮСОН Сервис (системный, был `beta`, переключён на `vip`) → подписка VIP до 2099-12-31, source=admin (вечная). Идентифицируется по `email='system@pluson.ru'`.

**Гранты при прогоне миграций.** Если роль БД ≠ postgres — после миграций обязательно: `GRANT SELECT, INSERT, UPDATE, DELETE ON features, tariff_features, client_subscriptions TO <role>; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO <role>;`

### PLUSSON — одна платформа, не два продукта
- **ivision-conf — не отдельный продукт.** Это аккаунт Марго в PLUSSON с модулем «Конференция»
- **Репо `ivision-conf`** хранит только статичный лендинг текущей конференции. Весь TMA, бэкенд, бот и redirect_web_app — здесь, в `referalka`
- **Модульная архитектура:** ядро ([Игра]) всегда, дополнительные вкладки — через модули. Модули: `conference`, `webinar`, `training`, `promo`

### Smart Bridge — редирект с лендинга в Telegram Mini App
- Лендинги событий: `/l/{event_slug}` (Next.js динамический маршрут, данные из БД). **Slug всегда латиницей** — только `[a-z0-9-]`. Кириллица в публичных URL запрещена.
- **Формат slug (с 28.04.2026):**
  - **По умолчанию** — 5-символьный случайный код (`_make_unique_short_slug` в [`backend/app/api/events.py`](backend/app/api/events.py)). Алфавит — `23456789abcdefghjkmnpqrstuvwxyz` (без визуально похожих 0/o, 1/l/i). Пример: `pluson.ru/l/x7q9k`. Применяется в `create_event` и `copy_event` — не зависит от названия, не «протухает» при переименовании.
  - **Кастомный** — клиент во вкладке «Основное» события вписывает свой латиницей в поле «Код ссылки», например `ivision-8`. Сохранение через `PATCH /events/{id} { slug }` с валидацией формата (`^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$`, длина 3–60) и проверкой уникальности (409 если занят). Старые slug-и (с транслитом названия) продолжают работать.
  - Транслитерация (`slugify()`) сохранена в [`backend/app/api/modules/conference.py`](backend/app/api/modules/conference.py) для других сущностей внутри конференции, но для slug-а событий больше не используется.
- Каждый лендинг включает `redirect_web_app.js`: если `?app=tg` → редирект в Telegram с параметрами
- Формат startapp: `ref_pg{event_slug}[_pid{partner_id}][_src{utm_source}]`
- Mini App (App.tsx): при открытии вызывает `requestWriteAccess` (разрешение боту писать), отправляет `event_start` на бэкенд, бот шлёт приветствие
- Веб-ссылка: `https://plusson.app/l/ivision-7`
- Ссылка в Telegram: `https://plusson.app/l/ivision-7?app=tg`
- С партнёром и UTM: `https://plusson.app/l/ivision-7?app=tg&pid=abc123&utm_source=insta` (старое имя `new_partner_id` тоже работает — fallback в `redirect_web_app.js`)

### Визитка клиента — разделение «Бренд / Основатель» (миграция 052 от 30.04.2026)

Визитка в Mini App — **две сущности**:

**Бренд** — то что в шапке Экосистемы:
- `clients.brand_name` — название (iVISION). Если NULL → fallback на `clients.name`.
- `clients.profile_photo_url` — фото бренда.
- `clients.brand_logo_url` — **логотип в правом углу всех страниц Mini App** (тап → Экосистема).
- `clients.positioning` — позиционирование бренда.
- `clients.achievements` JSONB `[{label,value}]` — «Факты в цифрах» бренда (скрывается если пусто).

**Основатель** — отдельная страница [`mini-app/src/pages/OwnerPage.tsx`](mini-app/src/pages/OwnerPage.tsx):
- ⚠️ Отдельной колонки `clients.owner_name` в БД **нет** — миграция её не создала. Имя основателя в UI берётся из `clients.name` (техническое имя из регистрации). При SQL-запросах не использовать `owner_name`.
- `clients.owner_photo_url` — фото основателя.
- `clients.owner_positioning` — позиционирование основателя.
- `clients.owner_achievements` JSONB `[{label,value}]` — «Факты в цифрах» основателя.
- `clients.bio` — биография.
- `clients.social_links` JSONB — соцсети основателя (бренд без соцсетей в MVP).

⚠️ `clients.name` — техническое имя для регистрации/JWT/админки. В дашборде показывается **readonly** с подписью «Имя из регистрации. Для смены — напишите в Тех.поддержку».

**Mini App** ([`EcosystemTab.tsx`](mini-app/src/tabs/EcosystemTab.tsx)):
- Шапка-бренд: фото бренда + название + позиционирование, **без слова «ЭКОСИСТЕМА»**.
- Блок «Факты в цифрах» (бренда) — скрыт если массив пуст.
- Карточка-тизер «Об основателе» со стрелкой → открывает `OwnerPage` (большое фото, имя, позиционирование, факты, биография, соцсети).
- Логотип бренда (`brand_logo_url`) в правом верхнем углу шапок [`Hub.tsx`](mini-app/src/pages/Hub.tsx) и [`EventPage.tsx`](mini-app/src/pages/EventPage.tsx) — тап навигирует в Экосистему.

**Дашборд** [`/dashboard/mini-app`](web/src/app/dashboard/mini-app/page.tsx) — **3 вкладки**: «Бренд» / «Основатель» / «Продукты». Все фото грузятся через `<FileUploader />` с новыми kinds: `brand_photo`, `brand_logo`, `owner_photo`. R2-структура: `clients/{cid}/profile/{kind}/{uuid}.jpg`. Лимиты ресайза: brand_photo 1200px, brand_logo 600px, owner_photo 1200px.

API:
- `PATCH /api/v1/clients/me/profile` принимает все 11 полей (бренд + основатель)
- `GET /api/v1/clients/me/profile` возвращает все поля
- `GET /api/v1/public/clients/{id}/profile` — публично для Mini App
- `GET /api/v1/public/events/{slug}/landing` дополнительно возвращает `client_brand_logo` (для логотипа в углу страницы события)

### Бренд клиента + Розыгрыш + VIP/Чат конференции (миграция 042 от 27.04.2026)

**Бренд клиента — `clients.brand_name`** (опционально). Используется в Экосистеме Mini App в шапке. Если NULL — fallback на `clients.name`. ⚠️ С миграции 052 расширено — см. раздел выше про разделение «Бренд / Основатель».

**Подсчёт подарков — `event_referral_settings.gift_count_mode`** = `'registered'` (default) | `'visited'`. Клиент в дашборде выбирает: подарки выдаются за зарегистрировавшихся или за переходы. Mini App показывает соответствующий счётчик.

**VIP-тариф и Чат — только для конференций** (поля в `events`):
- `has_vip_tariff` BOOL + `vip_price`, `vip_url`, `vip_title`, `vip_description` — кнопка VIP в программе и «КУПИТЬ VIP-ТАРИФ С ЗАПИСЯМИ» в итогах
- `vip_button_label` TEXT NULL (миграция 091 от 2026-05-21) — кастомный текст кнопки VIP в Mini App («Программа» + «Интро»). Если пусто — дефолт «Расшириться до VIP-тарифа». При клике в Mini App к `vip_url` дописывается партнёрский параметр контакта (`contacts.external_ref_param`) — резолв через `/public/events/{slug}/external-ref?pid=...`, аналогично сторонним лендингам. Хелпер: `redirectToVip` в [mini-app/src/pages/EventPage.tsx](mini-app/src/pages/EventPage.tsx), прокидывается в [ProgramTab](mini-app/src/tabs/ProgramTab.tsx) / [TurnirProgramTab](mini-app/src/tabs/TurnirProgramTab.tsx) / [WelcomePage](mini-app/src/components/WelcomePage.tsx) как `onVipClick`. Настраивается в дашборде — «Основное» мероприятия и «Настройки» конференции.
- `chat_url` + `chat_subscriptions_required` BOOL + `chat_member_count_label` (статичная подпись «900+ человек») — плитка чата в программе

**Розыгрыш** — три новые таблицы:
- `event_raffle_settings (event_id UNIQUE, is_enabled, draw_at, subscription_grants_starter_ticket, intro_text)` — общие настройки
- `event_raffle_prizes (event_id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active)` — список призов в раскрывающемся блоке Mini App
- `event_raffle_keywords (event_id, keyword, keyword_lower UNIQUE per event, tickets_reward, max_uses, used_count, sort_order, is_active)` — кодовые слова

API: `/api/v1/events/{event_id}/raffle/{settings|prizes|keywords}` (GET/POST/PATCH/DELETE).

**Один главный канал per платформа на клиента — UNIQUE индекс `channels(client_id, platform_slug) WHERE is_active`.** С 2026-04-30 семантика `is_active` уточнена и появилась возможность подключать **несколько TG-ботов на одного клиента** (только VIP).

- `is_active = TRUE` — **главный** канал. Через него: `/start`, регистрации, приветствия, callback'и бота, Mini App-кнопка, системные уведомления (приветствия спикерам, «привёл друга», подтверждения регистрации). Один на платформу клиента (UNIQUE-индекс).
- `is_active = FALSE` — **дополнительный** канал. Только база для рассылок — события не слушает, Mini App у него нет, callback'и игнорятся. Сколько угодно на одной платформе.
- Архивных каналов отдельно нет: ненужный — удаляется (`DELETE /api/v1/channels/{id}`, фронт защищён вводом слова «ПОДТВЕРДИТЬ» + предупреждением «лучше переведите в неактивный, если хотите отдать управление в другой сервис, и продолжать рассылать»).
- При смене главного (`PATCH ... { is_active: true }`) бэк одной транзакцией снимает флаг у предыдущего главного на этой платформе и ставит новому.
- В рассылках («по базе») — каждый получатель получает сообщение через **тот канал, на который реально подписан** (`platform_user_channels.is_unsubscribed=FALSE`). Если подписан на оба — приоритет главному. Если в базе нет привязки (легаси) — fallback на главный/первый канал клиента. Реализация — helper `get_telegram_send_targets` ([backend/app/services/channels.py](backend/app/services/channels.py)) + цикл в [backend/app/tasks/broadcast.py](backend/app/tasks/broadcast.py).
- Подписан/не подписан в `_build_audience` определяется как «есть хотя бы один не-отписанный telegram-канал клиента, либо записей в `platform_user_channels` нет». Отписан от ВСЕХ — исключаем.

**Приветствие при входе в Mini App теперь шлётся через бот клиента** — `backend/app/api/event.py` использует `get_client_telegram_token(client_id, db)` (определяя клиента по `event_slug` или `client_id` из startapp-параметра). Если у клиента не настроен канал — fallback на общего `@pluson_bot`.

### Импорт пользователей в канал из CSV (2026-04-30)

На карточке Telegram-канала в `/dashboard/channels` — кнопка-иконка `Upload`. Открывает модалку с инструкцией, кнопкой «Скачать шаблон» и зоной выбора файла.

**Колонки CSV** (любой регистр и порядок, поддержка алиасов и UTF-8 / CP1251):
- `telegram_id` — обязательно. Без него строка пропускается (без tg_id бот не сможет отправить).
- `name`, `telegram_username` (без @), `email`, `phone` — опционально.
- `subscribed` — `1`/`да` (default) или `0`/`нет`.

**Логика обработки строки** (см. [`backend/app/services/channel_import.py`](backend/app/services/channel_import.py)):
1. Ищем `platform_users (client_id, platform=telegram, tg_id)`. Нашли → `contact_id` известен, поля БД **не трогаем**.
2. Не нашли → ищем `contacts` по `email_normalized` или `phone_normalized` у того же клиента (мердж кросс-канал). Нашли → дозаполняем пустые поля COALESCE-ом, не перетираем непустые. Перед INSERT в `platform_users` проверяем коллизию `UNIQUE (contact_id, platform_slug)` — если у contact уже есть другой TG, пишем в отчёт и пропускаем.
3. Не нашли → создаём `contact` + `platform_users`.
4. `platform_user_channels` — UPDATE/INSERT с `is_unsubscribed = !subscribed` (целевое действие импорта, перетираем).

**Отчёт об ошибках** (TXT, скачивается из UI после импорта):
- Заголовок со статистикой (строк / создано / найдено / подписано / отписано / пропущено / нестыковок).
- Построчные нестыковки (CSV ≠ БД — оставлено как в БД).
- Пропуски (нет tg_id, невалидный tg_id, дубль внутри файла, конфликт identity).

**Endpoint:** `POST /api/v1/channels/{id}/import-csv` (multipart/form-data, поле `file`). Лимит 10 МБ. Только для Telegram-каналов.

### Файловое хранилище R2 (миграция 037 от 26.04.2026)

**Все файлы клиента (афиши, лид-магниты, сертификаты, материалы шеринга, фото спикеров) грузятся через единый endpoint `POST /api/v1/uploads` (FastAPI, не Next.js).** Бэкенд: ресайз картинок (Pillow) → upload в R2 (boto3) → запись в `client_files` → инкремент `clients.storage_used_bytes`.

**Структура ключей в R2:**
```
clients/{client_id}/events/{event_id}/posters/{horizontal|vertical|square}/{uuid}.jpg
clients/{client_id}/events/{event_id}/certificates/{uuid}.jpg
clients/{client_id}/events/{event_id}/referral_materials/{uuid}.jpg
clients/{client_id}/lead_magnets/{uuid}.{ext}
clients/{client_id}/speakers/{collaborator_id}/{uuid}.jpg
```

**Ресайз** (Pillow LANCZOS, JPEG q=85): афиши/материалы → 1920px, сертификаты → 1600px, фото спикеров → 800px. Без потери визуального качества для веб/мобильного, экономит 10–16× места.

**Квота:** `clients.storage_quota_bytes` = 500 МБ по умолчанию (`clients.storage_used_bytes` — кэш). На каждый upload — проверка `used + new_size <= quota` → 413. Индикатор использования в `/dashboard/settings` (зелёный/жёлтый ≥70%/красный ≥90%).

**Таблица `client_files`** (id, client_id, kind, r2_key UNIQUE, url, size_bytes, content_type, event_id, collaborator_id, lead_magnet_id, created_at) — учёт каждого загруженного файла.

**API:** `POST /api/v1/uploads` (kind, event_id, poster_type, collaborator_id), `DELETE /api/v1/uploads/by-url?url=...`, `GET /api/v1/storage/usage`.

**На фронте:** универсальный компонент `<FileUploader />` ([`web/src/components/FileUploader.tsx`](web/src/components/FileUploader.tsx)) с `mode=single|multiple`, `kind`, drag&drop, превью, кнопками «Ссылка»/«Удалить». Используется во ВСЕХ местах загрузки.

**Старый Next.js `/api/upload-poster`** — оставлен для обратной совместимости со старыми afishами, новые загрузки идут через FastAPI.

### Структура БД (после миграции 036 от 26.04.2026 — иерархия Контактов)

**Пять связанных таблиц для контактов и каналов:**
- **`platforms`** — справочник платформ (telegram/vk/max + метаданные: иконка, цвет, лимит сообщения, поддержка кнопок). Везде FK вместо TEXT-значений — нельзя записать опечатку.
- **`contacts`** — Контакт (ЧЕЛОВЕК). Один на клиента. Хранит: name, email, phone (с нормализованными версиями для мерджа), `ref_code` UNIQUE, `first_referrer_contact_id`, tags, salebot_id, utm_source, last_contact_at, `merged_into`, `merged_ref_codes`. Один человек = одна запись.
- **`platform_users`** — Идентичность контакта на платформе. `contact_id → contacts`, `platform_slug → platforms`. Один человек может иметь несколько идентичностей: TG-аккаунт + VK-аккаунт = две записи под одним contact_id. UNIQUE(contact_id, platform_slug) и UNIQUE(client_id, platform_slug, platform_user_id).
- **`channels`** — Каналы доставки клиента (его боты, группы VK, MAX-каналы). `platform_slug → platforms`.
- **`platform_user_channels`** — Подписка идентичности на канал. `platform_slug` дублируется + составные FK: TG-аккаунт нельзя подписать на VK-группу. `is_unsubscribed` per-канал.

**Иерархия использования:**
- `event_participants.contact_id → contacts` (был `platform_user_id`). Один человек = одно участие в событии.
- `collaborators.contact_id → contacts` (был `platform_user_id`).
- `referrer_participant_id` ссылается на `event_participants` — реферальная связь контекстная, только внутри события.
- ⚠️ `telegram_users` и `notifications_log` — удалены.
- Модульные таблицы с префиксом `conf_` принадлежат модулю «Конференция».
- Коллабораторы — глобальная база: `collaborators` + `conf_speaker_events`. У `collaborators` FK `contact_id → contacts(id)` **NOT NULL** (миграция 086 от 2026-05-18). Коллаб = «расширение контакта»: только должность, фото, регалии, бот-канал, личный TG и т.п.; имя/email/телефон — поля контакта. Создание идёт **только** из существующего контакта (`POST /api/v1/collaborators/ { contact_id }`) — модалка «Добавить из контактов» на `/dashboard/collaborations`. Импорт JSON (`POST /collaborators/import`) — если контакта с таким именем нет, авто-создаёт пустой и привязывает. На карточке коллаба блок «Контакт в общей базе» виден всегда; на карточке контакта (если есть запись в `collaborators`) — плашка «Этот контакт — коллаборатор» со ссылкой. Email/телефон контакта правятся inline на `/dashboard/clients` (`PATCH /api/v1/contacts/{id}`).
- `conf_speaker_events.notes` (миграция 041 от 2026-04-27) — произвольный текст под спикера в конкретной конференции (шпаргалка ведущего, частушка, заметки по гонорару). Редактируется на странице спикера в дашборде, в публичные endpoints (`/speakers/public`, `/speakers/{id}/public`) не отдаётся.
- `contacts.external_ref_param` (миграция 058 от 2026-05-05, перенесено с `collaborators` на `contacts` миграцией 103 от 2026-05-23) — опаковая строка `key=value` (например, `gcpc=fdd97`) для связки **контакта** с партнёрской системой во внешней платформе (GetCourse, Bizon360 и т.п.). Поле живёт на уровне контакта — любой контакт может быть партнёром во внешней системе, не обязательно коллаборатор. Не парсим, не валидируем — клиент сам знает, к какой системе привязывает партнёра. Редактируется на карточке контакта в `/dashboard/clients` (строка «Партнёрский параметр» рядом с реф-кодом, `PATCH /contacts/{id} { external_ref_param }`). **Общая логика** — [`backend/app/services/external_landing.py`](backend/app/services/external_landing.py): `resolve_external_ref_param(client_id, pid)` + `build_external_landing_url(...)`. Резолв идёт по `contacts.ref_code` (или `merged_ref_codes`) → `contacts.external_ref_param`. **Где приписывается** — все 4 точки, в которых открывается `events.landing_url`:
  1. `GET /api/v1/public/events/{slug}/landing-redirect` ([client_profile.py](backend/app/api/client_profile.py)) — для inline-скрипта `mini-app/index_tg.html` ДО React. Только при `status='published'` и не-зарегистрированном пользователе.
  2. `GET /api/v1/public/events/{slug}/external-ref?pid=…` (новый, [client_profile.py](backend/app/api/client_profile.py)) — справочник pid→`external_ref_param`. Работает независимо от status. Используется фронтами там, где `landing-redirect` не срабатывает.
  3. SSR `/l/[slug]/page.tsx` ([web](web/src/app/l/%5Bslug%5D/page.tsx)) — 301-редирект веб-входа без `?app=tg`. Перед `redirect()` фетчит `external-ref`.
  4. Mini App `EventPage.tsx` ([mini-app](mini-app/src/pages/EventPage.tsx)), функция `redirectToExternalLanding(landingUrl)` — useEffect (SPA-навигация на event с `landing_url`) и `handleWantParticipate` (клик «Хочу участвовать»). Перед `window.location.href` фетчит `external-ref`.

  Без `pid` или без коллаборатора с непустым параметром — поведение не меняется. Любая ошибка резолва — тихо игнорируется (основной редирект работает).

  **Обратная связь от лендинга через webhook (2026-05-23).** В URL стороннего лендинга Mini App добавляет `&platform_user_id={id}&platform={tg|vk|max}` (+ legacy `tg_id` / `vk_id` для совместимости). GetCourse/Tilda через стандартную фичу «Сохранять GET-параметры в форме» кладёт их в скрытые поля и шлёт в webhook [`POST/GET /api/v1/integrations/salebot/register`](backend/app/api/integrations.py). Webhook расширен:
  - **`platform_user_id`** теперь опционален — для веб-форм без TG/VK-айди работаем через `find_or_create_contact` (поиск по email/phone/`telegram_username`).
  - **`telegram_username`** — fallback-поиск контакта по TG-нику, если email/phone не дали результата (новый параметр `lookup_telegram_username` в `find_or_create_contact` / `upsert_contact_with_identity`).
  - **`pid`** — резолвится в `ref_code` партнёра через `resolve_ref_code` (с учётом `merged_ref_codes`), пишется в `event_participants.referrer_ref_code` (приоритет над `partner_tg_id`).
  - **`external_ref_param`** — UPSERT в `contacts.external_ref_param` (свежее значение из GetCourse перезатирает старое — клиент стал партнёром во внешней системе, мы фиксируем его код).

  Так замыкается круг «гость → партнёр»: человек кликает чью-то ссылку → попадает в Mini App → редирект на лендинг клиента с его `platform_user_id` → заполняет форму → GetCourse выдаёт ему свой партнёрский код → webhook обновляет `contacts.external_ref_param` → его собственная ссылка `pluson.ru/l/{slug}?pid={его_ref_code}` дописывает к лендингу клиента его GetCourse-партнёрский код → GetCourse начисляет ему награду.

  **UI-защита от draft.** При `events.status='draft'` партнёрские ссылки и сторонний лендинг не открываются у участников (`/landing-redirect` отдаёт `{}`). Чтобы клиент случайно не разослал партнёрам мёртвые ссылки:
  - Жёлтый баннер «⚠️ Это черновик…» в шапке `/dashboard/events/[id]` и `/dashboard/conferences/[id]`.
  - В `<PublicLinks>` (вкладка «Основное» события) и `<RefLinkInline>` (карточка соорганизатора/спикера) при `eventStatus='draft'` URL **затуманен** через CSS `filter: blur(...)` + `userSelect: none`, кнопка «Копировать» дисейблена + tooltip «Сначала опубликуйте событие». При попытке клика — `alert()` с пояснением.

### Мердж контактов (миграция 036)

**Автомердж при создании идентичности** (TG /start, импорт Salebot, Event_leads, регистрация на лендинге):
1. Нормализуем email (lowercase + trim) и phone (только цифры, `8` → `+7`)
2. Ищем `contact` у того же клиента где `email_normalized` или `phone_normalized` совпали
3. Нашли → новая `platform_users` ссылается на найденный `contact_id`
4. Не нашли → создаём `contact` + `platform_users`

⚠️ Поиск **только при создании**, не при апдейте.

**Ручной мердж** — кнопка «Объединить» в карточке. Все `platform_users`/`event_participants`/`collaborators`/`referrer_*` → главный контакт. Реф-код второстепенного → в `merged_ref_codes` JSONB. Второстепенный: `merged_into = главный.id`, `is_active = false`.

### ⚠️ Реф-код — один на человека, живёт в `contacts.ref_code` (миграция 032 от 26.04.2026, переехал в contacts миграцией 036)
- Поля `event_participants.ref_code` и `conf_speaker_events.ref_code` УДАЛЕНЫ (миграция 032)
- В `contacts.first_referrer_contact_id` хранится «кто впервые привёл человека в базу клиента»
- В `event_participants.referrer_ref_code` остаётся per-event реферер
- Резолв реферера: `JOIN contacts WHERE c.ref_code = referrer_ref_code` (с fallback на `merged_ref_codes`)
- Резолв спикера: `c.ref_code → collaborators.contact_id → conf_speaker_events`

### Лид-магниты + реф-программа как вкладка события (миграция 035 от 26.04.2026, обновлено миграцией 059 от 05.05.2026)
- Таблица **`lead_magnets`** (id, client_id, name, description, url) — общая база per-client. Один материал = одна запись (чек-лист, гайд, видео).
- Таблица **`event_posters`** (id, event_id, url, orientation `horizontal|vertical`, sort) — афиши события для лендинга/шеринга
- Таблица **`event_referral_settings`** (event_id UNIQUE, gift_count_mode, is_enabled) — настройки реф-программы события. ⚠️ Колонки `welcome_text` и `share_text` **удалены миграцией 059** (welcome_text не использовался, share_text заменён списком ниже).
- Таблица **`event_referral_thresholds`** (event_id, threshold_count, lead_magnet_id, certificate_url, gift_template_text) — пороги-подарки. UNIQUE (event_id, threshold_count). Один порог = одно количество приведённых.
- Таблица **`event_referral_materials`** (event_id, image_url, source `event_poster|custom`, source_poster_id) — картинки для шеринга участником.
- Таблица **`event_referral_share_texts`** (event_id, content, sort) — **тексты-примеры для шеринга** (миграция 059). Множественные. Один текст = одна запись. Существовавший `share_text` миграцией перенесён в первую запись.
- Расширение `events`: `address` (одно поле — URL стрима / ссылка на видео / офлайн-адрес), `start_at`, `end_at`
- API: `/api/v1/lead-magnets`, `/api/v1/events/{id}/posters`, `/api/v1/events/{id}/referral/{settings|thresholds|materials|share-texts}`
- **Дашборд** ([ReferralProgramTab.tsx](web/src/app/dashboard/events/[id]/tabs/ReferralProgramTab.tsx)): подвкладки **Подарки** (пороги + переключатель `gift_count_mode`) и **Материалы** (тексты + картинки). Старая подвкладка «Шаблоны» **удалена** миграцией 059. Копирование события и импорт реф-программы переносят `share_texts`.
- **Mini App — Материалы (Игра)** ([GameTab.tsx](mini-app/src/tabs/GameTab.tsx)): порядок секций — сначала «🖼 Афиши для друзей», потом «✍️ Тексты для друзей». Под каждым текстом две кнопки: **«📨 Нажмите, чтобы отправить себе в бот»** (отправляет готовое сообщение в бот клиента и закрывает Mini App через `Telegram.WebApp.close()` — пользователь возвращается в чат с ботом, где сообщение готово к форварду) и «📋 Скопировать текст». Endpoint: `POST /api/v1/event/share-to-bot { tg_id, event_slug, text }` ([backend/app/api/event.py](backend/app/api/event.py)).

### Рассылки — единый движок для мероприятий и конференций (миграция 060 от 05.05.2026)

**Один движок, разные шаблоны.** Все события (и `module_slug='conference'`, и обычные мероприятия) используют те же таблицы (`broadcast_templates`, `broadcast_schedules`, `broadcast_log`), тот же [`generate_schedules`](backend/app/api/modules/broadcasts.py), тот же [`message_builder.py`](backend/app/services/message_builder.py), тот же Celery-обработчик [`tasks/broadcast.py`](backend/app/tasks/broadcast.py). Различие — только в **наборе типов** шаблонов (auto-seed по `events.module_slug` при первом открытии вкладки «Рассылки»).

**Контракт `contacts.ref_code`** — теперь `NOT NULL` (миграция 060). У каждого контакта обязательно есть личный реф-код. Бэк может полагаться на это без проверок.

**Унифицированные имена типов** (после переименования миграцией 060):

| Тип | Когда срабатывает | Аудитория | Где |
|---|---|---|---|
| `day_before_09_12_unreg` | за сутки до `events.start_at`, в 09:12 МСК | нерег | только мероприятия |
| `day_before_09_12_reg`   | за сутки до `events.start_at`, в 09:12 МСК | зарег | только мероприятия |
| `2h_before_unreg` | за 120 мин до старта дня (конф) или `start_at` (меропр) | нерег | оба |
| `2h_before_reg`   | за 120 мин до старта | зарег | оба |
| `30min_before`    | за 30 мин до старта дня/события | все | оба |
| `5min_before`     | за 5 мин до старта **выступления спикера** (per-session) | все | **только конф** |
| `event_live`      | за 5 мин до старта мероприятия (events.start_at − 5 мин) | все | **только меропр** |
| `pre_conf` | за день в 10:43 МСК (анонс знакомства со спикерами) | все | только конф |
| `speaker_intro`, `gift`, `day_live`, `day_end`, `vip_offer` | конф-специфика | разное | только конф |

Старые имена `day_start_30min_unreg/reg`, `pre_start` миграцией 060 переименованы (включая поле `type` в `broadcast_schedules`). Не использовать в новом коде.

**Миграция 065 (05.05.2026)** — split `5min_before` на конф (per-session, остаётся `5min_before`) и мероприятие (event-level, новый тип `event_live`). До 065 один тип `5min_before` использовался в обоих контекстах с разной семантикой, что путало клиента в UI. Все существующие записи `5min_before` в `broadcast_templates` / `broadcast_schedules` / `broadcast_log` для **не-конференций** автоматически переведены в `event_live`. Auto-seed в `list_templates` теперь: для конф сидится `5min_before`, для меропр — `event_live`.

**Плейсхолдер `{game_link}`** — ссылка получателя на вкладку «Игра» события (партнёрский кабинет). Подставляется в момент отправки в Celery ([`tasks/broadcast.py`](backend/app/tasks/broadcast.py)): `https://t.me/{бот_клиента_или_pluson}?startapp=ref_pg{slug}_tabgame` (БЕЗ `_pid`). Получатели этих шаблонов уже зарегистрированы — их реферер зафиксирован при регистрации, перезатирать своим ref_code не надо. Mini App опознаёт получателя по `tg_id` из `initData`. В `message_builder.py` остаётся как литерал — подставляется только на самом последнем шаге.

Используется в шаблонах **`2h_before_reg`** и **`day_before_09_12_reg`** — для зарег. участников эфира ещё нет (за 2ч/сутки до старта), вместо ссылки на стрим предлагаем «🎯 Вы ещё успеваете позвать друзей и получить подарки» → их персональный кабинет.

**Mini App парсит `_tabXXX`** в startapp ([`App.tsx`](mini-app/src/App.tsx)) → передаёт `initialTab` в [`EventPage.tsx`](mini-app/src/pages/EventPage.tsx) → стартовая вкладка = указанная (game/raffle/program/ecosystem). Доступно только зарегистрированным; для нерег. флаг игнорируется (всегда landing).

**`generate_schedules`**:
- Для конференции — как раньше (по `conf_days`/`conf_sessions`). `5min_before` создаётся per-session.
- Для обычного мероприятия — точка отсчёта = `events.start_at`. Создаются: `event_live`, `30min_before`, `2h_before_unreg/reg` (relative offset до start_at) + `day_before_09_12_unreg/reg` (за сутки в 09:12 МСК). `5min_before` для мероприятий не используется — там `event_live`.
- **400** при попытке генерации если у конф нет программы (`conf_days` пуст) или у меропр не задан `events.start_at` — с понятным русским текстом ошибки.

**Флаг `is_overdue`** в API списка расписаний (`GET /broadcasts/schedules`) — `true` если `fire_at < NOW()` и статус `draft`/`pending`. Дашборд ([`broadcasts/queue/page.tsx`](web/src/app/dashboard/conferences/[id]/broadcasts/queue/page.tsx)) подсвечивает такие красной плашкой «⚠️ Время прошло — рассылка не отправится автоматически». Запись остаётся в `draft`, не уходит сама — клиент решает «перенести / отменить».

**Дашборд BroadcastsTab** — [один компонент](web/src/app/dashboard/events/[id]/tabs/BroadcastsTab.tsx) для мероприятий и конференций (две карточки: «Шаблоны» и «Очередь», ведут на `/dashboard/conferences/{id}/broadcasts/{templates|queue}` — URL-сегмент `conferences` исторический, эти страницы работают с любым событием).

### Выбор каналов отправки для рассылки (миграция 100 от 2026-05-22)

К каждой рассылке (произвольной и шаблонной) клиент может выбрать **подмножество** своих каналов. По умолчанию рассылка уходит **по всем** подключённым каналам — это поведение «как было до миграции», обратная совместимость сохраняется.

**Поле:** `target_channel_ids INTEGER[] NULL` в `broadcast_templates` и в `broadcast_schedules`.

**Семантика:**
- `NULL` — слать по всем каналам клиента (default).
- `[]` (пустой массив) — никуда не слать.
- `[3, 11]` — слать только через `channel_id` 3 и 11.

**Источник истины в Celery** ([backend/app/tasks/broadcast.py](backend/app/tasks/broadcast.py)) — fallback-цепочка:
1. `schedule.target_channel_ids` (приоритет — клиент мог переопределить per-расписание).
2. Если NULL и есть `schedule.template_id` → `template.target_channel_ids` (наследование от шаблона).
3. Если оба NULL → слать всем.

Это позволяет:
- Custom-рассылке задавать каналы вручную через UI формы.
- Шаблонной рассылке наследовать значение из шаблона **в момент отправки** — если клиент позже меняет состав каналов в шаблоне, это автоматически применится к ВСЕМ ещё-не-отправленным `broadcast_schedules` (что хорошо для авто-генерируемых через `generate_schedules`, которые сами поле не копируют).

**Фильтрация** применяется в каждой из 4 платформенных функций ([tasks/broadcast.py](backend/app/tasks/broadcast.py)):
- **Telegram** — фильтрует `send_jobs` по `channel_id in target_channel_set`.
- **VK** (`_send_broadcast_vk_part`), **MAX** (`_send_broadcast_max_part`), **Email** (`_send_broadcast_email_part`) — в начале функции; если итоговый `channel_id` платформы не в списке → `return 0` (вся платформа пропущена).

**UI** — общий компонент [BroadcastChannelPicker.tsx](web/src/components/BroadcastChannelPicker.tsx). Список всех каналов клиента, сгруппированный по платформам (Telegram → VK → MAX → Email), с счётчиком подписчиков справа и кнопкой «Снять всё/Выбрать все». По умолчанию все галочки включены — фронт всегда отдаёт массив. Используется в двух местах:
- Форма произвольной рассылки `/dashboard/broadcasts` (create + edit modals).
- Редактор шаблона `/dashboard/conferences/{id}/broadcasts/templates` (edit + create modals).

### ⚠️ Мультиплатформа — каналы доставки (миграции 033+034+036, 26.04.2026)
- Таблица **`channels`** (id, client_id, `platform_slug` → platforms, display_name, handle, bot_token, is_active) — каналы доставки клиента (бот в TG / группа VK / канал MAX). У клиента может быть несколько каналов.
- Таблица **`platform_user_channels`** (platform_user_id, channel_id, platform_slug, is_unsubscribed, subscribed_at, unsubscribed_at) — подписка идентичности на конкретный канал, отписка per-канал. Составные FK гарантируют совпадение платформ.
- Поле `clients.bot_token` УДАЛЕНО (033) — живёт в `channels.bot_token`
- Поле `platform_users.is_unsubscribed` УДАЛЕНО (034) — живёт в `platform_user_channels.is_unsubscribed` per-канал
- Поле `platform_users.platform` ВОЗВРАЩЕНО как `platform_slug → platforms(slug)` (036) — без него нельзя интерпретировать `platform_user_id` (это tg_id или vk_id?)
- UNIQUE `platform_users` после 036: `(contact_id, platform_slug)` + `(client_id, platform_slug, platform_user_id)`
- Helper `app/services/channels.py`: `get_client_telegram_token(client_id, db)`, `mark_unsubscribed_by_tg_id(client_id, tg_id, db)`, `upsert_client_telegram_token(client_id, token, db)`

### Архитектура дашборда (зафиксировано 2026-04-25)

**Концепция:** дашборд = модули. **Реферальная программа — не отдельная сущность**, а вкладка внутри каждого события. Раздел «Рефералки» из сайдбара убирается.

**Сайдбар:**

**База** (видна всегда, общая для клиента):
- Контакты — `contacts` (человек), карточка с группами по платформам и блоком «Каналы»
- Коллабораторы — `collaborators` с FK `contact_id → contacts`
- **Лид-магниты** — общая база per-client: `name`, `description`, `url`. Используется в реф-программе любого события.
- **Каналы** (новое, миграция 036) — CRUD по `channels`. Боты Telegram, группы VK, MAX-каналы клиента. С формы выбирается платформа (FK на `platforms`), задаётся `bot_token`/`handle`/`display_name`.

**События:**
- **Мероприятия** — базовый раздел, у всех клиентов. Покрывает вебинары, уроки в записи, нетворкинги, эфиры, мастер-классы. Все они — записи в `events` с разным `module_slug`.
- **Конференции** — опциональный модуль (расширенные настройки: спикеры, программа, услуги, промо-партнёры). Живёт в отдельном разделе дашборда `/dashboard/conferences` и в этой переустройстве не затрагивается.
- **Премии** — опциональный модуль (скоро)
- **Турниры** — опциональный модуль (скоро)

**Карточка Мероприятия — вкладки:**
1. **Основное** — название, описание, даты, лендинг URL, адрес (одно поле — либо URL стрима, либо офлайн-адрес)
2. **Афиши** — список изображений с ориентацией (горизонтальная/вертикальная), несколько штук. Используются на лендинге, в рассылках, в шеринге.
3. **Реф-программа** — три подвкладки в порядке:
   - **Подарки** — пороги (1/3/10 друзей и т.д.) → к каждому свой `lead_magnet_id` + опциональный сертификат (картинка)
   - **Материалы** — изображения (выбор из афиш события + загрузка своих) + текст-анонс. Готово для шеринга участником.
   - **Шаблоны** — текст приветствия (включает список всех подарков) + тексты выдачи каждого подарка от бота
4. **Участники** — список зарегистрированных + фильтр-таблетки «Все / Зарегистрированы / Не зарегистрированы» со счётчиками + поиск + чекбокс «Зарегистрирован» в каждой строке (ручное переключение `event_participants.is_registered`). Тот же UI используется во вкладке «Участники» конференции.
5. **Рассылки** — шаблоны и очередь, на это конкретное мероприятие

**Ручное управление статусом участника:**
- `event_participants.is_registered` — переключается из UI чекбоксом в строке участника. Двусторонне (можно поставить и снять).
- `event_participants.is_in_chat` — только автоматически (через Salebot), руками **не** правится.
- **Удаление участника из события** — иконка-корзина в строке + `confirm()`. Удаляется только `event_participants` (контакт, TG-аккаунт, подписки, участия в других событиях остаются). Каскад: `gift_issuances` этого участника удаляются, `referrer_participant_id` у других обнуляется, `raffle_tickets.pluson_participant_id` → NULL по FK.
- API: `PATCH /api/v1/events/{event_id}/participants/{participant_id}` `{ is_registered: bool }`, `DELETE /api/v1/events/{event_id}/participants/{participant_id}`. Список — `GET /api/v1/events/{id}/participants?registered=all|yes|no` возвращает `participants[]` + `counts {total, registered, not_registered}`.
- Общий React-компонент: [`web/src/components/EventParticipants.tsx`](web/src/components/EventParticipants.tsx) — используется и в карточке мероприятия, и в `ParticipantsTab` конференции.

**Лендинг и адрес — у всех мероприятий** (не зависит от типа). Если не нужно — оставляют пустым.

**Сертификаты у подарков** — в MVP просто загрузка картинки. Идея на будущее: автогенерация именных сертификатов (аватарка участника + имя на шаблоне через Pillow + Telegram `getUserProfilePhotos`).

### Архитектура Mini App (зафиксировано 2026-04-27, маршрутизация по боту 2026-04-28)

**Принцип:** двухуровневая навигация — **Хаб** и **Экран события**. Какой именно хаб открывается без `?startapp=ref_pg…` — **зависит от бота**.

| Бот | `/start` без параметров | `?startapp=ref_pg{slug}…` |
|---|---|---|
| Общий `@pluson_bot/pluson` (бесплатный, short-name `pluson` — одна «с») | **Селектор** (`mockup_hub_selector`) — список событий участника + вкладка «ПЛЮСОН» (промо стать клиентом) | Экран события |
| Бот клиента (про-тариф, напр. `@ivision_conf_bot`) | **Хаб владельца бота** (`mockup_hub`) — Календарь + Экосистема этого клиента | Экран события |

**Как определяется клиент — через путь URL `/c/{N}/tg/`:**

| URL | Что открывается |
|---|---|
| `pluson.ru/tg/` | HubSelector (общий @pluson_bot) |
| `pluson.ru/c/1/tg/` | Hub клиента 1 (бот клиента 1) |
| `pluson.ru/c/1/tg/event/{slug}` | EventPage в боте клиента 1 |
| `pluson.ru/tg/?cid=1` | Hub клиента 1 (legacy query, deprecated, для обратной совместимости) |

В BotFather при настройке Mini App для VIP-клиента указывается `https://pluson.ru/c/{N}/tg/`. Vite собран с `base: '/tg/'` — все ассеты грузятся с `/tg/assets/...` независимо от cid в URL. nginx делает internal rewrite `^/c/\d+/(.*)$ → /$1` ([nginx config](memory/dev_server.md)), один статический Mini App обслуживает ботов всех клиентов.

**Безопасность:** идентификатор клиента в URL не криптографически защищён — Telegram WebApp SDK не передаёт `bot_id`/`bot_username` ни в каком виде. Подмена `/c/1/` на `/c/2/` показывает Hub чужого клиента, но **только публичные данные** (визитку, опубликованные события). Приватные данные (рассылки, регистрации) выдаются по `tg_id` из подписанного `initData`, а не по `cid` из URL.

**Сейчас в MVP:** один общий бот `@pluson_bot` — в нём селектор. Бот клиента со своим Mini App — на VIP-тарифе. VIP-клиент сам через BotFather (`/newapp`) привязывает свой бот к URL `https://pluson.ru/c/{N}/tg/`.

**VIP-онбординг (миграция 045 от 28.04.2026)** — фича-флаг `tariffs.allow_custom_bot BOOL`. Тариф `vip` = `true`, дефолтный `beta` = `false`.

- `GET /api/v1/auth/me` отдаёт `tariff_name` и `allow_custom_bot`
- `POST /api/v1/channels/connect-telegram-bot {bot_token}` — wizard за один вызов: проверка тарифа → `getMe` (валидация токена) → upsert в `channels` → `setChatMenuButton` с URL `/c/{N}/tg/`. Возвращает `{bot_username, mini_app_url}` для копи-пейста в @BotFather (`/newapp`).
- `POST/PATCH /api/v1/channels` с `bot_token` для `telegram` — 403 если не VIP.
- В `/dashboard/channels` для не-VIP — read-only с апсейл-блоком, для VIP — 3-шаговый wizard ([web/src/app/dashboard/channels/page.tsx](web/src/app/dashboard/channels/page.tsx)).

#### Уровень 1а — Хаб организатора (бот клиента)

Нижние вкладки (всегда 2):
1. **📅 Календарь** — лента событий клиента: «Сейчас идёт» / «Скоро» / «Прошли». Клик по карточке → Экран события.
2. **🌐 Экосистема** — объединённая визитка + продукты:
   - Шапка: фото клиента, имя, 1-строчное позиционирование, регалии (3 карточки с цифрами), соцсети
   - Блок «Платно» — продукты с ценой / формой заявки (`client_offerings.is_paid = true`)
   - Блок «Бесплатно» — материалы, гайды, открытые сообщества (`client_offerings.is_paid = false`)

#### Уровень 1б — Селектор (общий `@pluson_bot`)

Нижние вкладки (всегда 2):
1. **📅 События** — события группируются **по организаторам** (брендам). См. правила ниже.
2. **➕ ПЛЮСОН** — промо-вкладка «Сделайте так же со своим событием», CTA «Создать кабинет» → `pluson.ru/register`. Видна каждому участнику.

**Правила формирования вкладки «События» в селекторе:**

1. **VIP-клиенты исключаются.** События клиентов с `tariffs.allow_custom_bot = true` в общем боте **не показываются** — у них собственный бот со своим хабом. Подписчик идёт туда через лендинг события VIP-клиента.
2. **Группа = организатор** (один не-VIP клиент). Заголовок группы — `client.brand_name || client.name` + аватар (`profile_photo_url`) + позиционирование.
3. **В группу попадают** те клиенты, у которых пользователь:
   - был участником ≥ 1 события (`event_participants.contact_id` через `platform_users.platform_user_id = tg_id`), ИЛИ
   - является владельцем (`clients.telegram_username == platform_users.username`).
4. **Что показываем внутри группы:**
   - Все опубликованные **будущие/идущие** события клиента — даже если пользователь там не участник (это промо).
   - **Прошедшие события** — только те, где пользователь был участником. Чужие прошедшие события не показываем (бесполезный шум, действовать с ними нельзя).
   - Если пользователь — владелец клиента → показываем все опубликованные/завершённые события клиента (его собственный календарь в общем боте).
5. **Сортировка событий внутри группы:** `now` (asc по start_at) → `soon` (asc по start_at) → `past` (desc по end_at).
6. **Сортировка групп:**
   - Сначала группы, у которых есть будущие/идущие события — между собой по **ближайшему предстоящему** ASC.
   - Потом группы, у которых **только прошедшие** — между собой по **самому свежему прошедшему** DESC.

**Бэкенд:** `GET /api/v1/participants/miniapp/me/events?tg_id={tg_id}` ([backend/app/api/participants.py](backend/app/api/participants.py)). Ответ: `{ groups: [{ client_id, client_name, client_brand_name, client_photo_url, client_positioning, events: [{..., bucket, participation_status}] }] }`. Bucket вычисляется на бэке. Для конференций даты — из `conf_days`.

**Фронтенд:** [mini-app/src/tabs/SelectorEventsTab.tsx](mini-app/src/tabs/SelectorEventsTab.tsx) — рендерит группы с заголовком (аватар + бренд) и карточки событий внутри.

#### Статус участия в карточке (Хаб + Селектор)

В правой части пилюли «Скоро / Идёт сейчас / Завершено» — чип статуса пользователя в этом событии:
- **`new`** — нет записи в `event_participants` (ещё ни разу не открывал событие). Подпись «Новое», нейтрально-серый.
- **`interested`** — запись есть, `is_registered=false` (открывал, до регистрации не дошёл). Подпись «Вы интересовались», голубой.
- **`registered`** — `is_registered=true`. Подпись «✓ Вы записаны», золотой `#FFCFA4`.

Поле `participation_status` приходит с бэка:
- В Селекторе — всегда (запрос требует `tg_id`).
- В Хабе организатора — `GET /api/v1/public/clients/{id}/events?tg_id=...` ([backend/app/api/client_profile.py](backend/app/api/client_profile.py)). Без `tg_id` поле `null` и чип не показывается (для публичного просмотра без TG).

CSS-классы: `.status-pill.status-pill-{new|interested|registered}`. Контейнер `.badge-row` в `.hub-card .body` через `margin-left: auto` отправляет чип к правому краю строки.

Контент Экосистемы редактируется клиентом в **`/dashboard/mini-app`** (раздел «MINI APP» в сайдбаре). На странице две вкладки: «Визитка» (`PATCH /clients/me/profile`) и «Продукты» (CRUD `/client-offerings`).

#### Уровень 2 — Экран события (3 состояния)

Состояние определяется по `events.status` + датам `start_at` / `end_at`.

**А. ДО регистрации участника (`event_participants.is_registered = false`):**
- Контент = только лендинг (афиша + описание + дата + кнопка «Хочу участвовать»)
- Нижние вкладки (5): `📋 Лендинг (открыта)`, `🔒 Программа`, `🔒 Игра`, `🔒 Розыгрыш`, `🔒 Экосистема`
- Тап по 🔒 → попап «Зарегистрируйтесь чтобы открыть»
- В контенте никаких «замков с объяснениями» — лендинг чистый

**Б. ПОСЛЕ регистрации (событие активно или ещё впереди):**
- Шапка: название + дата (через сколько дней / идёт сейчас)
- Нижние вкладки (4): `📅 Программа`, `🎯 Игра`, `🎟 Розыгрыш`, `🌐 Экосистема`
- **Вкладки «Лендинг» и «Главное» НЕТ** — после регистрации Программа = главный экран
- Программа: только расписание выступлений + кнопка «Подключиться к стриму» когда событие идёт. **Без афиши, без описания, без статуса** — это уже было показано на лендинге
- Стрим (`conf_days.stream_url`) виден **только зарегистрированным**
- Розыгрыш — только если включён модуль для события
- Экосистема (раньше называлась «Услуги») — единый шаблон с Экосистемой в Хабе и в состоянии В: визитка клиента + переключатель Платно/Бесплатно + продукты клиента и партнёров (`conf_commercial_items` per-event объединяются с `client_offerings` клиента)

**В. ПОСЛЕ завершения события:**
- Нижние вкладки (4) — комбинация события и хаба:
  1. `📋 Итоги` — спасибо + статистика участника (сколько привёл) + блок «А дальше: следующее событие» (автоматически — ближайшее предстоящее опубликованное событие клиента)
  2. `🎯 Игра` — финальная статистика рефералки этого события
  3. `📅 Календарь` (от хаба) — события клиента
  4. `🌐 Экосистема` (от хаба) — визитка + продукты

#### Поток регистрации (между состоянием А и Б)

1. Лендинг → тап «Хочу участвовать»
2. **Форма контактов**: имя (preflled из TG), email, телефон (TG `requestContact` или ввод вручную)
3. Сабмит → `event_participants` создаётся с `is_registered = true`, `contacts.email/phone` обновляются → переход на состояние Б

⚠️ **Подписки на каналы при регистрации НЕ проверяются.** Чек-листа подписок и `getChatMember` в потоке регистрации нет. Подписка нужна только для доступа в чат события (отдельная плитка/кнопка в Программе, поле `events.chat_subscriptions_required`).

#### Проверка подписки на каналы организаторов (унифицировано 07.05.2026, расширено 08.05.2026)

При тапе на плитку чата в Mini App ([ProgramTab.tsx](mini-app/src/tabs/ProgramTab.tsx) `openChatWithCheck`) проверка подписки идёт через `GET /api/v1/public/conference/{event_id}/check-subscription` ([subscription_check.py](backend/app/api/subscription_check.py)). Логика:

- **Конференция** (`conf_conferences.subscription_mode`):
  - `none` → пропускаем, чат открывается без проверки
  - `organizer` → проверяем подписку на каналы коллабораторов с `role='organizer'`
  - `all_speakers` → проверяем подписку на каналы ВСЕХ коллабораторов конференции
- **Мероприятие** (без `conf_conferences`):
  - `events.require_subscription = false` → пропускаем
  - `events.require_subscription = true` → проверяем подписку на каналы соорганизаторов мероприятия (`event_collaborators` с `role='organizer'`)

В обоих случаях источник один и тот же — `event_collaborators` ЭТОГО события + `exclude_channel_from_subscription=FALSE` + непустой `tg_channel_id`. Никаких LIMIT — берутся ВСЕ подходящие. Раньше для мероприятий ошибочно искался один канал в любой конференции клиента.

**`bot_in_channel` НЕ фильтрует SQL** (изменено 08.05.2026). Канал всегда возвращается участнику — он должен увидеть его и подписаться. Если бот не админ канала — `getChatMember` вернёт «не член» независимо от того, подписан ли реально человек, и проверка станет «ложно-отрицательной». Это сознательный компромисс: лучше дать клиенту запустить событие без обязательной настройки бота в каждом канале, чем тихо пропускать всех участников. Дашборд предупреждает о ложной проверке (см. ниже). Полностью исключить канал из проверки и из показа — тумблер «Исключить канал из проверки подписки» (`exclude_channel_from_subscription=TRUE`).

**UI у соорганизаторов мероприятия** (с 08.05.2026):
- Страница [/dashboard/events/[id]/organizers/[ec_id]](web/src/app/dashboard/events/%5Bid%5D/organizers/%5BecId%5D/page.tsx) — блок «Канал для проверки подписки» с инструкцией, кнопкой «Проверить, что бот в канале» (`POST /events/{event_id}/collaborators/{ec_id}/verify-channel`) и тумблером «Исключить канал из проверки подписки» (`PATCH /events/{event_id}/collaborators/{ec_id} { exclude_channel_from_subscription }`).
- Вкладка «Соорганизаторы» ([CoOrganizersTab.tsx](web/src/app/dashboard/events/%5Bid%5D/tabs/CoOrganizersTab.tsx)) — бейдж под именем: «⚠️ Проверка ложная — бот не в канале» (если `require_subscription=TRUE`, есть канал, но `bot_in_channel=FALSE`), «Канал исключён из проверки» или «Бот в канале».
- Логика верификации идентична спикерам конференции — `getChatMember(channel, personal_tg_id)` через бот клиента; при успехе ставит `bot_in_channel=TRUE`.

Список не подписавшихся каналов выводится в Mini App нумерованным списком (`<ol>` с круглым PEACH-бейджем 1/2/3 слева).

#### Связь между событиями (наследование)

«А дальше» — автоматически: после завершения текущего события блок предлагает ближайшее предстоящее опубликованное событие того же клиента (по `start_at` ASC). Поле `events.successor_event_id` удалено миграцией 065 — клиент ничего не настраивает, всё решается логикой.

#### Замки в нижней панели

`BottomNav` принимает массив доступных вкладок + показывает остальные с иконкой замка. Тап по закрытой → попап. **Замки НЕ в контенте** — только в нижней навигации.

### Продуктовые решения
- **В MVP — один общий бот `@pluson_bot` и один Mini App** на всех Клиентов. На верхних тарифах у клиента будет свой бот (напр. `@ivision_conf_bot`) со своим Mini App, в котором открывается личный хаб владельца. См. раздел «Архитектура Mini App» выше.
- **Mini App = приложение сервиса**, Клиент брендирует своё событие через афишу и название
- **Нет white label, нет кастомного домена** — Участник не взаимодействует с веб-версией
- **MVP без paywall** — все Клиенты на «beta»-тарифе, все модули открыты. Платёжка — в Этапе 2
- **Партнёрская программа в MVP** — таблица `partners`, поле `clients.partner_code`, раздел «Партнёры» в Admin-панели

### Таблица `tariffs`
Существует с первого дня. Запланировано минимум 2 тарифа:
- **Базовый** — урезанный функционал
- **Профессиональный** — полный функционал
- Возможно, средний тариф в будущем

**Пробный период:** длительность задаётся в настройках Администратора. В MVP — **12 месяцев** для всех. Все новые Клиенты автоматически получают пробный период.

В MVP все Клиенты на тарифе `beta` (пробный период 12 мес, все лимиты = ∞). Middleware проверки лимитов написан, но для `beta` возвращает разрешение на всё.

---

## Дизайн-система

**Референс:** Slack.com — структура и навигация, но в бренд-цветах с градиентами
**Ощущение:** статусно, бизнесово, premium
**Тема:** светлая основа с тёмными акцентами

| Роль | HEX |
|---|---|
| Основной (фон, шапки) | `#25455D` — всегда через градиент к `#0a1520` под углом 45° |
| Акцентный / Золото (кнопки, CTA, линии, декор) | `#FFCFA4` — персиково-жёлтый с металлическим отливом |
| Базовый (фон карточек) | `#FFFFFF` |

> **Правило градиента:** везде где фон `#25455D` — применять `linear-gradient(45deg, #25455D, #0a1520)`. Чистый `#25455D` без градиента не использовать.

- Sidebar-навигация слева в Web-кабинете (как Slack)
- Градиент фонов: `#25455D` → `#0a1520`, угол 45°
- Золотые линии и декор — цвет `#FFCFA4`
- Шрифт: **Roboto** (Google Fonts)
- Mini App: те же цвета, мобильная адаптация
- Логотип белый (тёмный фон): `images/logo_no_ivision_wwhite.png`
- Логотип синий (светлый фон): `images/logo_no_ivision_blue.png`

---

## Статус разработки (обновлено 2026-04-06)

### Задеплоено и работает 🚀

**Инфраструктура:**
- Сервер: Beget VPS 194.156.119.17, Ubuntu 24.04
- Домен: https://pluson.ru (Let's Encrypt SSL, nginx). Старый https://pluson.margoforbs.ru работает параллельно
- База данных: PostgreSQL на VPS, все миграции применены
- Бот: @pluson_bot, токен в `.env`
- Mini App: зарегистрирован в BotFather, short name `pluson` (ОДНА «с»! не `plusson`)
- Mini App TG на dev: https://dev.pluson.ru/tg/ (nginx alias на `mini-app/dist/`, vite `base: '/tg/'`)
- Mini App VK на проде: https://pluson.ru/vk/ (nginx alias на `mini-app/dist-vk/`, vite `base: '/vk/'`)

### Mini App — единый пакет TG/VK/MAX (рефакторинг 2026-05-20)

С 2026-05-20 `mini-app/` обслуживает **все платформы** одним исходным кодом. Папка `mini-app-vk/` удалена. Структура:

```
mini-app/
├── src/
│   ├── platform/
│   │   ├── index.ts        — PlatformAdapter interface + getPlatform()/setPlatform()
│   │   ├── telegram.ts     — TG-адаптер (Telegram.WebApp)
│   │   ├── vk.ts           — VK-адаптер (@vkontakte/vk-bridge)
│   │   └── max.ts          — MAX-адаптер (window.WebApp, SDK подключается тегом)
│   ├── main-tg.tsx         — точка входа TG: init + setPlatform + рендер App
│   ├── main-vk.tsx         — точка входа VK
│   ├── App.tsx             — общий, branching через `platform.name`
│   ├── api.ts              — общий, getPlatformName() для ?platform= в нужных запросах
│   ├── tabs/ pages/ components/ — общие, физически по одному файлу
│   └── styles/
├── index_tg.html           — с inline-скриптом landing-redirect для TG
├── index_vk.html           — короче, без landing-redirect (VK работает иначе)
├── vite.config.tg.ts       — base: '/tg/', outDir: 'dist'
├── vite.config.vk.ts       — base: '/vk/', outDir: 'dist-vk'
└── package.json            — build:tg + build:vk + build (запускает оба)
```

**Сборка:**
```bash
cd mini-app && npm run build
# → dist/index.html + dist/assets/... (TG)
# → dist-vk/index.html + dist-vk/assets/... (VK)
```

**Правило:** любая фича в Mini App пишется один раз в `mini-app/src/` — попадает во все платформы автоматически. Платформо-специфичное (init SDK, обработка funnel-ссылок VK, диалоги VK Bridge на email/phone) — внутри `if (getPlatformName() === 'vk')` в App.tsx или в `platform/vk.ts`.

**MAX-фронт:** ещё не задеплоен (пока работает только бэк — миграция 090 + max_api/max_auth/max_event/max_webhook). Когда будет нужен — добавить `main-max.tsx` + `index_max.html` + `vite.config.max.ts` + nginx-блок `/max/`. Адаптер `platform/max.ts` уже готов (SDK почти идентичен Telegram WebApp).

См. `memory/project_mini_app_unification_plan.md` и `memory/feedback_check_duplicated_packages.md`.
- Клиент: margarita.vl2011@gmail.com / Playball8013!
- Администратор: admin@plusson.app / Mill20ion!Forbs

### Что разработано ✅

**БД (`db/`)**
- `db/migrations/001_schema.sql` — полная схема: tariffs, modules, partners, clients, admins, events, event_subscriptions, telegram_users, event_participants, referral_levels, referral_events, gifts, materials, gift_issuances, notifications_log, promo_materials + все таблицы модуля conf_*
- `db/migrations/002_indexes.sql` — индексы
- `db/seed/001_initial.sql` — начальные данные: модули, тариф Beta (бесплатный), клиент Маргарита Владимировна (margarita.vl2011@gmail.com, @margo_forbs)

**Backend (`backend/`)**
- FastAPI приложение с CORS, lifespan, health-check
- `app/api/auth.py` — регистрация (JWT + bcrypt), вход клиента, вход администратора
- `app/api/events.py` — CRUD событий, аналитика, slugify
- `app/api/gifts.py` — CRUD подарков события
- `app/api/participants.py` — регистрация участника, активация, get by tg_id
- `app/api/referral.py` — редирект /r/{ref_code}, вебхук конверсии
- `app/api/admin.py` — статистика, клиенты, партнёры, тарифы, создание администраторов
- `app/api/modules/conference.py` — спикеры, сессии, услуги, кодовые слова, промо-партнёры
- `app/services/referral_engine.py` — реферальный движок (генерация кодов, конверсии, подарки)
- `app/services/notification_service.py` — отправка TG-сообщений, 3 сегмента
- `bot/handlers/start.py` — /start с ref_code и без
- `bot/main.py` — polling-режим бота

**Web-кабинет (`web/`)**  — Next.js 14 App Router + Tailwind CSS
- `/register` — регистрация (split-screen, bullet-points, JWT)
- `/login` — вход клиента
- `/verify-email` — подтверждение email
- `/dashboard` — список событий (grid cards, empty state)
- `/dashboard/events/new` — создание события шаг 1 (модуль, подписка)
- `/dashboard/events/new/gifts` — шаг 2: подарки
- `/dashboard/events/[id]` — карточка события (метрики, реф. ссылка, топ рефереров)
- `/dashboard/events/[id]/analytics` — таблица участников
- `/dashboard/events/[id]/materials` — афиша, текст анонса
- `/dashboard/events/[id]/conference` — модуль конференция (спикеры, программа, услуги, рассылки, промо-партнёры, кодовые слова)
- `/dashboard/settings` — профиль, бот-токен, подписка
- `/admin` — обзор платформы (4 метрики + карточка первого клиента)
- `/admin/clients` — список клиентов с поиском
- `/admin/partners` — партнёры, создание, копирование ссылок
- `/admin/tariffs` — тарифы, текущий Beta выделен

**Mini App (`mini-app/`)** — React + Vite + Telegram SDK
- `App.tsx` — роутинг, инициализация TG WebApp, парсинг startapp-параметров
- `pages/Dashboard.tsx` — список событий участника; если событие одно — открывает его автоматически
- `pages/EventPage.tsx` — страница события с bottom-навигацией
- `tabs/GameTab.tsx` — вкладка [Игра]: 4 пилюли (Прогресс, Подарки, Материалы, Поделиться)
- `tabs/ProgramTab.tsx` — вкладка [Программа]: расписание по дням, сессии со спикерами
- `tabs/ServicesTab.tsx` — вкладка [Услуги]: коммерческие предложения
- `tabs/RaffleTab.tsx` — вкладка [Розыгрыш]: счётчик билетов, ввод кодовых слов
- Нижняя навигация адаптируется под module_slug события

### Роутинг мини-апп и startapp-параметры

**Поток открытия:**
1. Пользователь открывает бота (по диплинку или напрямую)
2. `App.tsx` читает `twa.initDataUnsafe.start_param` — там может быть `ref_pid{id}_src{utm}`
3. Парсит `pid` → `partnerId`, `src` → `utmSource` — однозначно, без путаницы
4. Открывает `Dashboard`, который запрашивает события участника из БД по `telegram_id`
5. Если **1 событие** → авто-открывает `EventPage` для него
6. Если **несколько** → показывает список (участник выбирает)
7. Если **0 событий** → показывает экран «нет событий»

**Формат startapp:** `ref_pid{partner_id}_src{utm_source}`
- `ref` — обязательный префикс-маркер
- `pid` — реф-код партнёра (URL-параметр `?pid=…`, старое имя `?new_partner_id=…` поддержано как fallback), опционально
- `src` — utm_source, опционально
- Примеры: `ref`, `ref_pid5725111966`, `ref_srcinsta`, `ref_pid5725111966_srcinsta`

**Ссылки из лендинга (ivision-conf):**
- Веб: `https://ivision.pluson.ru/ivision-conf-7` (без `app=tg`)
- Бот: `https://ivision.pluson.ru/ivision-conf-7?app=tg[&pid=...][&utm_source=...]` (старое имя `new_partner_id` поддержано)
- Старый домен `https://ivision.margoforbs.ru/*` отдаёт 301-редирект на `ivision.pluson.ru/*` (на Beget nginx) — старые ссылки в Salebot/GetCourse/афишах продолжают работать, но новые публиковать только с новым доменом.
- Каждый HTML-лендинг содержит скрипт: если `app=tg` → redirect на `t.me/Margo_forbs_bot/ivision?startapp=...`

**partnerId / utmSource** передаются в `EventPage` для fallback-регистрации (если участник не был зарегистрирован через GetCourse).

### Что ещё нужно сделать

- [ ] Подключить реальные данные события в `/l/[slug]` из PostgreSQL (сейчас stub)
- [ ] Подключить реальный ivision-7 через GetCourse webhook
- [ ] Настроить Celery рассылки (Celery + Redis — Redis уже установлен)

---

## Структура проекта

```
referalka/
├── CLAUDE.md                    ← этот файл (авточтение Claude)
├── registration.html            ← прототип страницы регистрации
├── documentation/
│   ├── BRIEF.md                 ← бизнес-описание продукта (что строим, для кого, зачем)
│   ├── BACKEND-PLAN.md          ← технический план: БД, API, права доступа, бизнес-логика
│   ├── PLAN.md                  ← план разработки MVP (чек-лист с [x] / [ ])
│   └── TESTING.md               ← сценарии тестирования и чеклист перед деплоем
├── images/
│   ├── logo_no_ivision_wwhite.png  ← логотип белый (тёмные фоны)
│   └── logo_no_ivision_blue.png    ← логотип синий (светлые фоны)
├── db/
│   ├── migrations/001_schema.sql  ← полная схема БД
│   ├── migrations/002_indexes.sql ← индексы
│   └── seed/001_initial.sql       ← начальные данные (тариф Beta, клиент Маргарита)
├── backend/                       ← FastAPI + aiogram (Beget VPS, systemd)
│   ├── app/main.py                ← точка входа API
│   ├── app/api/                   ← все роутеры
│   ├── app/services/              ← реферальный движок, уведомления
│   └── bot/                       ← Telegram бот
├── web/                           ← Next.js кабинет Клиента (Beget VPS, порт 3000)
│   └── src/app/                   ← страницы: auth, dashboard, admin
└── mini-app/                      ← Telegram Mini App (Beget VPS, nginx статика)
    └── src/                       ← App, pages, tabs, components
```
