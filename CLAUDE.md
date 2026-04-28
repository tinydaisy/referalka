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
> **Все правки и эксперименты идут на DEV-сервер `62.113.98.30` (dev.pluson.margoforbs.ru).**
> **Прод `194.156.119.17` (pluson.margoforbs.ru) — ТОЛЬКО по явной команде пользователя** («деплой на прод», «выкати на продакшн» и т.п.).
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
  - **Dev:** `62.113.98.30` / `dev.pluson.margoforbs.ru` (Ubuntu 24.04). Все новые правки сначала идут сюда
  - **Прод:** `194.156.119.17` / `pluson.margoforbs.ru`. Деплой на прод — только после явного подтверждения пользователя
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
| Домен | pluson.margoforbs.ru (DNS в Vercel → VPS) |

---

## Ключевые архитектурные решения (зафиксированы, не менять)

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
- Лендинги событий: `/l/{event_slug}` (Next.js динамический маршрут, данные из БД). **Slug всегда латиницей** — `slugify()` в [`backend/app/api/events.py`](backend/app/api/events.py) и [`backend/app/api/modules/conference.py`](backend/app/api/modules/conference.py) транслитерирует кириллицу (а→a, ж→zh, ю→yu, …) и оставляет только `[a-z0-9-]`. Кириллица в публичных URL запрещена.
- **Формат slug:** `<транслит-названия>-<случайный-5-символьный-код>` (например `konferentsiya-ivision-7-x7q9k`). Алфавит кода — `23456789abcdefghjkmnpqrstuvwxyz` (без визуально похожих 0/o, 1/l/i). Применяется в `create_event` и `copy_event`. Старые slug-и без кода продолжают работать. Бэкенд не использует счётчики `-1`, `-2` — только случайный код, что снимает гонки и делает URL стабильным независимо от названия.
- Каждый лендинг включает `redirect_web_app.js`: если `?app=tg` → редирект в Telegram с параметрами
- Формат startapp: `ref_pg{event_slug}[_pid{partner_id}][_src{utm_source}]`
- Mini App (App.tsx): при открытии вызывает `requestWriteAccess` (разрешение боту писать), отправляет `event_start` на бэкенд, бот шлёт приветствие
- Веб-ссылка: `https://plusson.app/l/ivision-7`
- Ссылка в Telegram: `https://plusson.app/l/ivision-7?app=tg`
- С партнёром и UTM: `https://plusson.app/l/ivision-7?app=tg&new_partner_id=123&utm_source=insta`

### Бренд клиента + Розыгрыш + VIP/Чат конференции (миграция 042 от 27.04.2026)

**Бренд клиента — `clients.brand_name`** (опционально). Используется в Экосистеме Mini App в шапке. Если NULL — fallback на `clients.name`. Работает в паре с уже существующими `clients.profile_photo_url`, `positioning` (роль владельца), `achievements` JSONB (4 регалии {label,value} для сетки 2×2). API: `PATCH /api/v1/clients/me/profile { brand_name, positioning, achievements: [{label,value}×4], profile_photo_url }`. Публичный: `GET /api/v1/public/clients/{id}/profile`.

**Подсчёт подарков — `event_referral_settings.gift_count_mode`** = `'registered'` (default) | `'visited'`. Клиент в дашборде выбирает: подарки выдаются за зарегистрировавшихся или за переходы. Mini App показывает соответствующий счётчик.

**VIP-тариф и Чат — только для конференций** (поля в `events`):
- `has_vip_tariff` BOOL + `vip_price`, `vip_url`, `vip_title`, `vip_description` — кнопка «ОПЛАТИТЬ VIP-ТАРИФ» в программе и «КУПИТЬ VIP-ТАРИФ С ЗАПИСЯМИ» в итогах
- `chat_url` + `chat_subscriptions_required` BOOL + `chat_member_count_label` (статичная подпись «900+ человек») — плитка чата в программе

**Розыгрыш** — три новые таблицы:
- `event_raffle_settings (event_id UNIQUE, is_enabled, draw_at, subscription_grants_starter_ticket, intro_text)` — общие настройки
- `event_raffle_prizes (event_id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active)` — список призов в раскрывающемся блоке Mini App
- `event_raffle_keywords (event_id, keyword, keyword_lower UNIQUE per event, tickets_reward, max_uses, used_count, sort_order, is_active)` — кодовые слова

API: `/api/v1/events/{event_id}/raffle/{settings|prizes|keywords}` (GET/POST/PATCH/DELETE).

**Один активный канал per платформа на клиента** — UNIQUE индекс `channels(client_id, platform_slug) WHERE is_active`. Старый канал можно отключить (`is_active=false`), новый создать с тем же `platform_slug`.

**Приветствие при входе в Mini App теперь шлётся через бот клиента** — `backend/app/api/event.py` использует `get_client_telegram_token(client_id, db)` (определяя клиента по `event_slug` или `client_id` из startapp-параметра). Если у клиента не настроен канал — fallback на общего `@pluson_bot`.

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

### Лид-магниты + реф-программа как вкладка события (миграция 035, 26.04.2026)
- Таблица **`lead_magnets`** (id, client_id, name, description, url) — общая база per-client. Один материал = одна запись (чек-лист, гайд, видео).
- Таблица **`event_posters`** (id, event_id, url, orientation `horizontal|vertical`, sort) — афиши события для лендинга/шеринга
- Таблица **`event_referral_settings`** (event_id UNIQUE, welcome_text, share_text) — общие тексты реф-программы события
- Таблица **`event_referral_thresholds`** (event_id, threshold_count, lead_magnet_id, certificate_url, gift_template_text) — пороги-подарки. UNIQUE (event_id, threshold_count). Один порог = одно количество приведённых.
- Таблица **`event_referral_materials`** (event_id, image_url, source `event_poster|custom`, source_poster_id) — картинки для шеринга участником
- Расширение `events`: `address` (одно поле — URL стрима / ссылка на видео / офлайн-адрес), `start_at`, `end_at`
- API: `/api/v1/lead-magnets`, `/api/v1/events/{id}/posters`, `/api/v1/events/{id}/referral/{settings|thresholds|materials}`
- UI (БЛОК 3.Б, ещё не сделан): новый раздел сайдбара «Лид-магниты», новый раздел «Мероприятия», убрать «Рефералки», вкладки в карточке события (Основное / Афиши / Реф-программа / Рассылки)

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
- API: `PATCH /api/v1/events/{event_id}/participants/{participant_id}` `{ is_registered: bool }`. Список — `GET /api/v1/events/{id}/participants?registered=all|yes|no` возвращает `participants[]` + `counts {total, registered, not_registered}`.
- Общий React-компонент: [`web/src/components/EventParticipants.tsx`](web/src/components/EventParticipants.tsx) — используется и в карточке мероприятия, и в `ParticipantsTab` конференции.

**Лендинг и адрес — у всех мероприятий** (не зависит от типа). Если не нужно — оставляют пустым.

**Сертификаты у подарков** — в MVP просто загрузка картинки. Идея на будущее: автогенерация именных сертификатов (аватарка участника + имя на шаблоне через Pillow + Telegram `getUserProfilePhotos`).

### Архитектура Mini App (зафиксировано 2026-04-27, маршрутизация по боту 2026-04-28)

**Принцип:** двухуровневая навигация — **Хаб** и **Экран события**. Какой именно хаб открывается без `?startapp=ref_pg…` — **зависит от бота**.

| Бот | `/start` без параметров | `?startapp=ref_pg{slug}…` |
|---|---|---|
| Общий `@pluson_bot/plusson` (бесплатный) | **Селектор** (`mockup_hub_selector`) — список событий участника + вкладка «ПЛЮСОН» (промо стать клиентом) | Экран события |
| Бот клиента (про-тариф, напр. `@ivision_conf_bot`) | **Хаб владельца бота** (`mockup_hub`) — Календарь + Экосистема этого клиента | Экран события |

**Как определяется клиент — через путь URL `/c/{N}/tg/`:**

| URL | Что открывается |
|---|---|
| `pluson.margoforbs.ru/tg/` | HubSelector (общий @pluson_bot) |
| `pluson.margoforbs.ru/c/1/tg/` | Hub клиента 1 (бот клиента 1) |
| `pluson.margoforbs.ru/c/1/tg/event/{slug}` | EventPage в боте клиента 1 |
| `pluson.margoforbs.ru/tg/?cid=1` | Hub клиента 1 (legacy query, deprecated, для обратной совместимости) |

В BotFather при настройке Mini App для VIP-клиента указывается `https://pluson.margoforbs.ru/c/{N}/tg/`. Vite собран с `base: '/tg/'` — все ассеты грузятся с `/tg/assets/...` независимо от cid в URL. nginx делает internal rewrite `^/c/\d+/(.*)$ → /$1` ([nginx config](memory/dev_server.md)), один статический Mini App обслуживает ботов всех клиентов.

**Безопасность:** идентификатор клиента в URL не криптографически защищён — Telegram WebApp SDK не передаёт `bot_id`/`bot_username` ни в каком виде. Подмена `/c/1/` на `/c/2/` показывает Hub чужого клиента, но **только публичные данные** (визитку, опубликованные события). Приватные данные (рассылки, регистрации) выдаются по `tg_id` из подписанного `initData`, а не по `cid` из URL.

**Сейчас в MVP:** один общий бот `@pluson_bot` — в нём селектор. Бот клиента со своим Mini App — на VIP-тарифе. VIP-клиент сам через BotFather (`/newapp`) привязывает свой бот к URL `https://pluson.margoforbs.ru/c/{N}/tg/`.

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
1. **📅 События** — список событий **всех** клиентов где участник есть. Группы: «Идёт сейчас» / «Скоро» / «Прошедшие». На каждой карточке указан организатор. Тап → Экран события.
2. **➕ ПЛЮСОН** — промо-вкладка «Сделайте так же со своим событием», CTA «Создать кабинет» → `pluson.margoforbs.ru/register`. Видна каждому участнику.

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
3. **Чек-лист подписок** на каналы из `event_subscriptions` (если включено `events.subscription_required`)
4. Проверка через TG Bot API `getChatMember` для каждого канала
5. Все галки → `event_participants` создаётся с `is_registered = true`, `contacts.email/phone` обновляются → переход на состояние Б

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
- Домен: https://pluson.margoforbs.ru (SSL, nginx)
- База данных: PostgreSQL на VPS, все миграции применены
- Бот: @pluson_bot, токен в `.env`
- Mini App: зарегистрирован в BotFather, short name `plusson`
- Mini App на dev: https://dev.pluson.margoforbs.ru/tg/ (nginx alias на `mini-app/dist/`, vite `base: '/tg/'`)
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
- `pid` — промо-партнёр (new_partner_id), опционально
- `src` — utm_source, опционально
- Примеры: `ref`, `ref_pid5725111966`, `ref_srcinsta`, `ref_pid5725111966_srcinsta`

**Ссылки из лендинга (ivision-conf):**
- Веб: `https://ivision.margoforbs.ru/ivision-conf-7` (без `app=tg`)
- Бот: `https://ivision.margoforbs.ru/ivision-conf-7?app=tg[&new_partner_id=...][&utm_source=...]`
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
