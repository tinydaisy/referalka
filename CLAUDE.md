# CLAUDE.md — Правила работы с проектом

> Этот файл Claude Code читает автоматически при каждом старте сессии.

---

## Что это за проект

**ПЛЮСОН** — реферальный сервис Марго Форбс. Платформа управляемого вирального роста.
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

### Воронки выдачи лид-магнитов (миграции 062, 063 от 05.05.2026)

**Зачем.** Лид-магниты выдаются через бот по фиксированной схеме: «приветствие со списком подарков → проверка подписки на канал → выдача файлов → 30-минутный follow-up». Можно объединять несколько лид-магнитов в один пакет под единой ссылкой.

**Где живёт ссылка на воронку:**
- Одиночный лид-магнит: `pluson.ru/m/{slug}` (5-символьный код алфавит без визуально похожих)
- Пакет: `pluson.ru/p/{slug}`
- С UTM и партнёром: `pluson.ru/m/x7q9k?utm_source=insta&pid=abc123`. UTM любые — всё в `funnel_runs.utm` JSONB. `pid` резолвится в `referrer_contact_id` через `contacts.ref_code`.

**Куда ведёт landing:**
- VIP-клиент с `tariffs.allow_custom_bot=TRUE` и подключённым TG-ботом → `t.me/<его_бот>?start=fnl_<run_id>`
- Иначе → `t.me/pluson_bot?start=fnl_<run_id>`

В обоих случаях наш polling-сервис ([backend/bot/main.py](backend/bot/main.py)) держит обработчики. Multi-bot polling: один Python-процесс крутит и @pluson_bot, и все VIP-боты клиентов параллельно через asyncio.gather.

**Бот-флоу:**
1. `/start fnl_<run_id>` ([backend/bot/handlers/start.py](backend/bot/handlers/start.py)) — создаём `contact` + `platform_users` если новый человек, ставим `stage=started`, шлём уведомление организатору, отправляем **Текст 1** с inline-кнопкой «ГОТОВО».
2. Callback `fnl_check_<run_id>` ([backend/bot/handlers/funnel.py](backend/bot/handlers/funnel.py)) — `getChatMember` на `clients.social_links.telegram`. Если подписан → `stage=delivered`, шлём **Текст 2** со списком `1. Название — <ссылка>`, шедулим Celery `app.tasks.funnel.send_text_3` на 30 мин. Если нет — алерт «Не вижу подписки на канал».
3. Через 30 мин Celery шлёт **Текст 3** ([backend/app/services/funnel_service.py](backend/app/services/funnel_service.py) `send_text_3`): версия `delivered` для получивших, `stuck` для зависших.

**Канал подписки.** Бот проверяет подписку на канал, который клиент вписал в `clients.social_links.telegram` (визитка основателя в `/dashboard/mini-app`, вкладка «Основатель»). Бот должен быть админом этого канала. Если поле пустое — проверку пропускаем, выдаём сразу.

**Канал уведомлений организатору** (`clients.notifications_telegram_chat_id`):
- Уведомления всегда шлёт @pluson_bot (даже для VIP). Формат: «🆕 Новый интерес: <магнит/пакет> · кто пришёл (`@username` · `#contact_id`) · UTM · кто привёл · ссылки на карточки контактов».
- Шлётся при первом переходе `landed → started`.
- VIP-клиент добавляет @pluson_bot админом в свой служебный канал, пересылает любое сообщение из канала в @pluson_bot — handler `/getchatid` отвечает с chat_id.
- Поле настраивается в `/dashboard/settings` → вкладка «Технические» → блок «Канал уведомлений» с инструкцией.

**Шаблон воронки** ([backend/app/api/funnels.py](backend/app/api/funnels.py)) — один на клиента, тип `'lead_magnet'`. Auto-create при первом GET с дефолтными текстами. 5 редактируемых полей: `text_1`, `button_label`, `text_2`, `text_3_delivered`, `text_3_stuck`. Создание новых шаблонов нельзя, только править существующий. Плейсхолдеры подставляются в момент отправки: `{materials_list}` (нумерованный список названий), `{materials_with_links}` (название + ссылка), `{client_brand_name}`, `{client_owner_name}`, `{client_owner_achievements}`, `{subscription_channel}`, `{owner_telegram}`.

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

### Приветствие при открытии события (миграция 064 от 05.05.2026)

При каждом `event_start` из Mini App ([backend/app/api/event.py](backend/app/api/event.py)) бот клиента (или fallback `@pluson_bot`) шлёт пользователю **контекстное** сообщение с inline-кнопкой. Тип сообщения определяется автоматически:

| `kind` | Когда | Текст | Кнопка → |
|---|---|---|---|
| `register_cta` | `is_registered=false`, событие активно | «Добро пожаловать на «{title}» 🎉» + дата | «Зарегистрироваться» → `…?startapp=ref_pg{slug}` |
| `referral_reminder` | `is_registered=true`, не завершилось | «Вы ещё успеваете пригласить друзей…» | «Получить подарки» → `…?startapp=ref_pg{slug}_tabgame_pid{ref_code}` |
| `next_event_cta` | завершилось + есть `successor_event_id` (не draft) | «Спасибо за ваш интерес. Следующее: «{succ}» {дата}» | «Записаться на следующее» → `…?startapp=ref_pg{succ_slug}` |
| `ecosystem_thanks` | завершилось, успешник не задан | «Спасибо за ваш интерес. Заходите в Экосистему — там полезные материалы.» | «Открыть Экосистему» → `…?startapp=ref_pg{slug}_tabecosystem` |

Завершение для конференций — `MAX(conf_days.day_date + close_time)` < сейчас МСК, для остальных — `events.end_at` или `status='ended'`.

**Дедуп — БД, не память.** В `event_participants` две колонки (миграция 064):
- `last_open_msg_kind TEXT`
- `last_open_msg_at TIMESTAMPTZ`

Логика: если новый `kind ≠ last_open_msg_kind` — шлём (статус сменился). Если совпадает — проверяем `broadcast_log` per `platform_user_id` контакта: если **после** `last_open_msg_at` были рассылки от бота клиента → наше сообщение «уехало вверх», шлём заново. Если рассылок не было — пропускаем.

Старый 5-минутный in-memory `_was_welcomed` удалён.

URL Mini App: для VIP — `https://t.me/{handle}` (бот клиента, без short-name), для общего — `https://t.me/pluson_bot/pluson` (с short-name `pluson`). Резолв `handle` — из `channels` per `client_id` (как в `tasks/broadcast.py`).

### Авто-редирект внутри Mini App webview на iOS (рецепт)

Если из Mini App нужно автоматически (без клика) перебросить webview
на внешний URL — **только** через `window.location.replace(url)` (или
`.href`), **не** через `Telegram.WebApp.openLink` или `window.open`.
iOS блокирует второе как popup без user-gesture.

Полный recipe с готовым кодом, минимальным backend-endpoint и обработкой
возврата (флаг в startapp + защита от петли) — в
[documentation/MINI-APP-WEBVIEW-REDIRECT.md](documentation/MINI-APP-WEBVIEW-REDIRECT.md).
В этом проекте применяется в [mini-app/index.html](mini-app/index.html) для
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
- `clients.owner_name` — имя основателя (отдельно от технического `clients.name` из регистрации).
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
- `has_vip_tariff` BOOL + `vip_price`, `vip_url`, `vip_title`, `vip_description` — кнопка «ОПЛАТИТЬ VIP-ТАРИФ» в программе и «КУПИТЬ VIP-ТАРИФ С ЗАПИСЯМИ» в итогах
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
- Коллабораторы — глобальная база: `collaborators` + `conf_speaker_events`. У `collaborators` FK `contact_id → contacts(id)`.
- `conf_speaker_events.notes` (миграция 041 от 2026-04-27) — произвольный текст под спикера в конкретной конференции (шпаргалка ведущего, частушка, заметки по гонорару). Редактируется на странице спикера в дашборде, в публичные endpoints (`/speakers/public`, `/speakers/{id}/public`) не отдаётся.
- `collaborators.external_ref_param` (миграция 058 от 2026-05-05) — опаковая строка `key=value` (например, `gcpc=fdd97`) для связки коллаборатора с партнёрской системой во внешней платформе (GetCourse, Bizon360 и т.п.). Не парсим, не валидируем — клиент сам знает, к какой системе привязывает партнёра. **Где приписывается:** `GET /api/v1/public/events/{slug}/landing-redirect` (endpoint, который зовёт `mini-app/index.html` для авто-редиректа на `events.landing_url` ДО React-bundle) — если в запросе есть `pid` и он резолвится в коллаборатора с непустым `external_ref_param`, параметр приписывается к URL стороннего лендинга через `&` в самом конце. Без `pid` или без коллаборатора с этим полем — поведение не меняется.

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

**Плейсхолдер `{game_link}`** — личная ссылка получателя на вкладку «Игра» события (партнёрский кабинет). Подставляется в момент отправки в Celery ([`tasks/broadcast.py`](backend/app/tasks/broadcast.py)) per-recipient: `https://t.me/{бот_клиента_или_pluson}?startapp=ref_pg{slug}_tabgame_pid{ref_code}`. В `message_builder.py` остаётся как литерал — подставляется только на самом последнем шаге.

Используется в шаблонах **`2h_before_reg`** и **`day_before_09_12_reg`** — для зарег. участников эфира ещё нет (за 2ч/сутки до старта), вместо ссылки на стрим предлагаем «🎯 Вы ещё успеваете позвать друзей и получить подарки» → их персональный кабинет.

**Mini App парсит `_tabXXX`** в startapp ([`App.tsx`](mini-app/src/App.tsx)) → передаёт `initialTab` в [`EventPage.tsx`](mini-app/src/pages/EventPage.tsx) → стартовая вкладка = указанная (game/raffle/program/ecosystem). Доступно только зарегистрированным; для нерег. флаг игнорируется (всегда landing).

**`generate_schedules`**:
- Для конференции — как раньше (по `conf_days`/`conf_sessions`). `5min_before` создаётся per-session.
- Для обычного мероприятия — точка отсчёта = `events.start_at`. Создаются: `event_live`, `30min_before`, `2h_before_unreg/reg` (relative offset до start_at) + `day_before_09_12_unreg/reg` (за сутки в 09:12 МСК). `5min_before` для мероприятий не используется — там `event_live`.
- **400** при попытке генерации если у конф нет программы (`conf_days` пуст) или у меропр не задан `events.start_at` — с понятным русским текстом ошибки.

**Флаг `is_overdue`** в API списка расписаний (`GET /broadcasts/schedules`) — `true` если `fire_at < NOW()` и статус `draft`/`pending`. Дашборд ([`broadcasts/queue/page.tsx`](web/src/app/dashboard/conferences/[id]/broadcasts/queue/page.tsx)) подсвечивает такие красной плашкой «⚠️ Время прошло — рассылка не отправится автоматически». Запись остаётся в `draft`, не уходит сама — клиент решает «перенести / отменить».

**Дашборд BroadcastsTab** — [один компонент](web/src/app/dashboard/events/[id]/tabs/BroadcastsTab.tsx) для мероприятий и конференций (две карточки: «Шаблоны» и «Очередь», ведут на `/dashboard/conferences/{id}/broadcasts/{templates|queue}` — URL-сегмент `conferences` исторический, эти страницы работают с любым событием).

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
  1. `📋 Итоги` — спасибо + статистика участника (сколько привёл) + блок «А дальше: следующее событие» (`events.successor_event_id`)
  2. `🎯 Игра` — финальная статистика рефералки этого события
  3. `📅 Календарь` (от хаба) — события клиента
  4. `🌐 Экосистема` (от хаба) — визитка + продукты

#### Поток регистрации (между состоянием А и Б)

1. Лендинг → тап «Хочу участвовать»
2. **Форма контактов**: имя (preflled из TG), email, телефон (TG `requestContact` или ввод вручную)
3. Сабмит → `event_participants` создаётся с `is_registered = true`, `contacts.email/phone` обновляются → переход на состояние Б

⚠️ **Подписки на каналы при регистрации НЕ проверяются.** Чек-листа подписок и `getChatMember` в потоке регистрации нет. Подписка нужна только для доступа в чат события (отдельная плитка/кнопка в Программе, поле `events.chat_subscriptions_required`).

#### Связь между событиями (наследование)

`events.successor_event_id` — какое событие предлагать после завершения текущего. На состоянии В блок «А дальше» автоматически берёт следующее. Решает кейс «конференция прошла → дальше нетворкинг».

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
- Mini App на dev: https://dev.pluson.ru/tg/ (nginx alias на `mini-app/dist/`, vite `base: '/tg/'`)
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
- Веб: `https://ivision.margoforbs.ru/ivision-conf-7` (без `app=tg`)
- Бот: `https://ivision.margoforbs.ru/ivision-conf-7?app=tg[&pid=...][&utm_source=...]` (старое имя `new_partner_id` поддержано)
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
