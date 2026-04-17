# BACKEND-PLAN.md — Технический план бэкенда ПЛЮСОН

> Этот файл описывает: какие данные хранятся, какие API существуют, кто что видит и редактирует.
> Используется как руководство при разработке и доработке бэкенда.

---

## Стек и хостинг

| Компонент | Технология | Хостинг |
|---|---|---|
| База данных | PostgreSQL 16 | Beget VPS (тот же сервер) |
| Backend API | Python + FastAPI | Beget VPS |
| Telegram Bot | Python + aiogram 3 | Beget VPS |
| Очереди рассылок | Celery + Redis | Beget VPS |
| Web-кабинет | Next.js 14 | Beget VPS (порт 3000, nginx proxy) |
| Mini App | React + Vite | Beget VPS (статика, nginx) |

---

## Безопасность — Верификация Telegram initData

Участники авторизуются через Telegram Mini App. Каждый запрос от Mini App содержит заголовок `X-Telegram-Init-Data: {initData}`.

**Алгоритм проверки на бэкенде (обязательно!):**
```
1. Из initData извлечь строку hash и остальные поля
2. Собрать data_check_string: отсортировать поля по алфавиту, соединить \n
3. secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN)
4. expected_hash = HMAC-SHA256(data_check_string, secret_key)
5. Сравнить expected_hash == hash из initData
6. Проверить auth_date — не старше 24 часов
7. Если всё верно → извлечь user.id → это и есть tg_id участника
```

Если подпись не совпадает → `401 Unauthorized`. Без этой проверки любой может подделать запрос с чужим tg_id.

---

## Роли и права доступа

| Роль | Как авторизуется | Что видит / делает |
|---|---|---|
| **Клиент** | JWT (email + пароль) | Только свои события, подарки, аналитику, рекламные материалы |
| **Участник** | Telegram ID (через initData) | Только свои события и прогресс по ним |
| **Администратор** | JWT (отдельный логин) | Всё: все клиенты, события, партнёры, тарифы |
| **Бот** | SERVICE_KEY в заголовке | Регистрация участников, старт с ref_code |
| **Webhook** | WEBHOOK_SECRET в заголовке | Конверсия (смена статуса участника) |

---

## Схема базы данных

### Ядро платформы

**`tariffs`** — тарифные планы
- `slug` (beta / basic / pro), `name`, `price`, `trial_days`, `max_events`, `max_participants` — лимиты
- В MVP все клиенты на `beta`: trial_days=365, все лимиты = ∞

**`modules`** — подключаемые модули
- `slug` (base / conference / webinar / training / promo), `name`, `is_active`

**`partners`** — партнёры сервиса (приводят Клиентов в ПЛЮСОН)
- `partner_code` (уникальный UTM, напр. VASYA), `name`, `percent`, `contact`, `notes`

**`clients`** — клиенты сервиса (создают события)
- `email`, `password_hash`, `name`, `tariff_id`, `trial_ends_at`, `partner_code` (откуда пришёл), `bot_token` (свой бот, опционально)

**`admins`** — администраторы платформы
- `email`, `password_hash`, `role` (super / support)

**`client_modules`** — какие модули подключены у клиента
- `client_id`, `module_slug`

### События и участие

**`events`** — события клиентов
- `client_id`, `slug` (уникальный, напр. ivision-7), `title`, `module_slug`, `status` (draft/active/ended)
- `points_free` — баллов за бесплатную регистрацию
- `points_paid` — баллов за платную (0 = нет платного тарифа → одна реф. ссылка)
- `points_scope` (event / client) — баллы копятся в рамках события или всех событий клиента
- `landing_url` — куда ведёт реферальная ссылка
- `webhook_url` — куда клиент вешает ПЛЮСОН-webhook в своей платёжке
- `require_subscription` — требовать подписку на канал перед Игрой

**`event_subscriptions`** — каналы для проверки подписки (мессенджер-агностик)
- `event_id`, `platform` (telegram / max), `channel_id`, `channel_title`, `is_required`

**`telegram_users`** — глобальный реестр Telegram-аккаунтов (1 запись на человека)
- `tg_id` (BIGINT, unique), `username`, `first_name`

**`event_participants`** — факт участия (1 строка на каждое событие каждого человека)
- `event_id`, `tg_user_id`, `ref_code` (для бесплатной ссылки), `ref_code_paid` (для платной)
- `referrer_participant_id` → ссылается на `event_participants` (реферер в рамках этого события)
- `promo_partner_code` — промо-партнёр события (откуда пришёл участник на лендинг)
- `points_total`, `registered_at`, `activated_at` (когда открыл Игру)

### Реферальная механика

**`referral_events`** — лог кликов и конверсий
- `event_id`, `ref_code`, `visitor_tg_id`, `type` (click / free / paid), `points_awarded`, `level`

**`referral_levels`** — настройки многоуровневых баллов (заложено, в MVP не используется)
- `event_id`, `level` (1 = прямой), `points_free`, `points_paid`

### Подарки и материалы

**`gifts`** — подарки реферальной механики
- `event_id`, `title`, `description`, `points_cost`, `link_url`, `stock` (-1 = безлимит)

**`gift_issuances`** — выдачи подарков
- `gift_id`, `participant_id`, `status` (pending / issued)

**`materials`** — рекламные материалы события
- `event_id`, `title`, `link_url`, `type` (free / paid), `is_eternal`, `status` (active / archived)

**`promo_materials`** — афиши и тексты анонсов (загружаются Клиентом)
- `event_id`, `type` (poster / text_post / text_dm), `content_url`

**`notifications_log`** — лог всех отправленных уведомлений
- `event_id`, `tg_user_id`, `segment` (no_game / no_share / stalled), `message`, `sent_at`

### Модуль «Конференция» (prefix `conf_`)

**`conf_conferences`** — настройки конференции
- `event_id`, `start_date`, `end_date`, `stream_url_day_1/2`, `is_live`, `vip_upsell_url`

**`speakers`** — глобальная база спикеров клиента ⚠️ заменяет `conf_speakers`
- `client_id`, `name`, `slug`, `title`, `company`, `bio`, `photo_url`, `telegram_url`, `instagram_url`, `website_url`, `extra_info`
- Один спикер создаётся один раз, используется в разных конференциях клиента
- Каждый клиент видит только своих спикеров (`WHERE client_id = ?`)

**`conf_speaker_events`** — участие спикера в конкретной конференции (Many-to-Many)
- `speaker_id` → `speakers`, `event_id` → `events`
- `role` (organizer/headliner/commercial/speaker/partner), `topic` (тема выступления), `gift_title`, `gift_url`, `poster_url`
- Индивидуальная афиша спикера, подарок — своё для каждой конференции

**`conf_sessions`** — сессии программы
- `event_id`, `speaker_id`, `day`, `start_datetime`, `title`, `gift_description`, `sort_order`

**`conf_broadcast_messages`** — рассылки конференции
- `event_id`, `session_id/speaker_id`, `type` (pre_5min / speaker_intro / day_start / manual), `scheduled_at`, `text`, `status`

**`conf_commercial_items`** — услуги/коммерческие предложения
- `event_id`, `type` (service / material), `title`, `description`, `is_paid`, `action_url`

**`conf_secret_codes`** — кодовые слова для розыгрыша
- `event_id`, `speaker_id`, `code_word`, `tickets_reward`

**`conf_promo_partners`** — промо-партнёры события (не путать с партнёрами сервиса)
- `event_id`, `name`, `telegram_url`, `partner_code`

---

## Архитектура UI — модульный дашборд (зафиксировано 2026-04-17)

### Концепция

Дашборд разделён на **модули** — каждый модуль это отдельная «секция» кабинета.
Рефералка — не тип события, а **механика поверх любого события**.

### Структура навигации (сайдбар)

```
[Логотип]
───────────────
📊 Дашборд (главная — плитки модулей)
───────────────
РЕФЕРАЛКИ
  › Мои кампании
───────────────
КОНФЕРЕНЦИИ
  › Мои конференции
  › Мои спикеры
───────────────
  › Премии (скоро)
  › Турниры (скоро)
───────────────
⚙ Настройки
```

### Роутинг Web-кабинета

| Роут | Что |
|---|---|
| `/dashboard` | Главная: плитки модулей (Рефералки, Конференции, Премии, Турниры) |
| `/dashboard/referrals` | Список реферальных кампаний |
| `/dashboard/referrals/new` | Создать кампанию: новое событие ИЛИ навесить на существующее |
| `/dashboard/referrals/[id]` | Карточка кампании (метрики, ссылка, аналитика, подарки) |
| `/dashboard/conferences` | Список конференций клиента |
| `/dashboard/conferences/new` | Создать конференцию |
| `/dashboard/conferences/[id]` | Конференция: основное, спикеры, программа, рассылки, промо |
| `/dashboard/speakers` | База спикеров клиента |
| `/dashboard/speakers/[id]` | Карточка спикера (глобальные данные) |

### Модуль «Рефералки» — логика создания кампании

При создании реферальной кампании — два пути:
1. **Новое событие** → ввод названия, описания, ссылки → настройка подарков
2. **Привязать к существующему событию** → выбрать из конференций/турниров/премий → реф.ссылка формируется на базе этого события

В обоих случаях в `events` создаётся (или используется существующая) запись.

### Типы событий (module_slug в таблице events)

| module_slug | Тип | Доп. таблицы |
|---|---|---|
| `base` | Базовая реф. кампания | — |
| `conference` | Конференция | conf_conferences, speakers, conf_speaker_events, conf_sessions, ... |
| `award` | Премия | award_* (будущее) |
| `tournament` | Турнир | tournament_* (будущее) |

---

## API эндпоинты

Базовый путь: `/api/v1/`

### Авторизация (`/auth/`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| POST | `/auth/register` | Любой (форма регистрации) | Создаёт аккаунт клиента, возвращает JWT |
| POST | `/auth/login` | Клиент | Вход, возвращает JWT |
| POST | `/auth/admin/login` | Администратор | Вход в панель администратора |

### События (`/events/`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| GET | `/events/` | Клиент | Список своих событий |
| POST | `/events/` | Клиент | Создать событие |
| GET | `/events/{id}` | Клиент | Карточка события + метрики |
| PUT | `/events/{id}` | Клиент | Редактировать событие |
| DELETE | `/events/{id}` | Клиент | Удалить событие |
| GET | `/events/{id}/analytics` | Клиент | Таблица участников |

### Подарки (`/gifts/`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| GET | `/gifts/?event_id=` | Клиент / Участник | Список подарков события |
| POST | `/gifts/` | Клиент | Создать подарок |
| PUT | `/gifts/{id}` | Клиент | Редактировать подарок |
| DELETE | `/gifts/{id}` | Клиент | Удалить подарок |

### Участники (`/participants/`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| POST | `/participants/register` | Бот | Зарегистрировать участника в событии |
| POST | `/participants/activate` | Mini App | Активировать (открыл Игру) |
| GET | `/participants/by_tg/{tg_id}` | Mini App | Получить все события участника |

### Smart Bridge — открытие Mini App с лендинга (`/event`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| POST | `/event` | Mini App (App.tsx) при открытии | Регистрирует/обновляет пользователя в telegram_users, отправляет приветствие через бота |

**Поток:**
```
Пользователь переходит по ссылке /l/ivision-7?app=tg
→ redirect_web_app.js редиректит в Telegram: t.me/bot/app?startapp=ref_pgivision-7_pid123
→ Telegram открывает Mini App (React)
→ App.tsx: twa.requestWriteAccess() — диалог «Разрешить боту писать»
→ App.tsx: sendTgEvent('event_start', user, partnerId) → POST /api/v1/event
→ Бэкенд: upsert telegram_users + sendMessage приветствие
→ App.tsx: роутинг на EventPage для slug 'ivision-7'
```

**Файл:** `backend/app/api/event.py`

---

### Реферальный движок (`/referral/`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| GET | `/referral/r/{ref_code}` | Любой (браузер) | Логирует клик → редиректит на landing_url |
| POST | `/referral/conversion` | Webhook от лендинга | Засчитывает конверсию (free/paid) |

### Администратор (`/admin/`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| GET | `/admin/stats` | Администратор | Общая статистика платформы |
| GET | `/admin/clients` | Администратор | Список всех клиентов |
| GET | `/admin/clients/{id}` | Администратор | Карточка клиента |
| PATCH | `/admin/clients/{id}` | Администратор | Изменить тариф / статус |
| GET | `/admin/partners` | Администратор | Список партнёров |
| POST | `/admin/partners` | Администратор | Создать партнёра |
| GET | `/admin/tariffs` | Администратор | Список тарифов |
| POST | `/admin/admins` | Супер-администратор | Создать нового администратора |

### Примеры ответов ключевых эндпоинтов

**POST `/auth/login`** → что получает фронтенд:
```json
{ "access_token": "eyJ...", "token_type": "bearer", "client_id": 1, "name": "Маргарита" }
```

**GET `/events/`** → список событий клиента:
```json
[{ "id": 1, "slug": "ivision-7", "title": "iVision-7", "status": "active",
   "participants_count": 245, "module_slug": "conference" }]
```

**GET `/events/{id}`** → карточка события с метриками:
```json
{ "id": 1, "title": "iVision-7", "ref_url": "https://plusson.app/r/...",
  "stats": { "clicks": 410, "free_conversions": 245, "paid_conversions": 38,
             "gifts_issued": 91, "top_referrers": [...] } }
```

**POST `/participants/register`** → регистрация через бота:
```json
{ "participant_id": 42, "ref_code": "ABC123", "ref_url": "https://plusson.app/r/ABC123",
  "is_new": true }
```

**GET `/participants/by_tg/{tg_id}`** → события участника для Dashboard Mini App:
```json
[{ "event_id": 1, "slug": "ivision-7", "title": "iVision-7",
   "poster_url": "https://...", "invites_count": 3, "status": "active" }]
```

---

### Модуль «Конференция» (`/modules/conference/`)

| Метод | Путь | Кто вызывает | Что делает |
|---|---|---|---|
| GET/POST | `/modules/conference/speakers` | Клиент | Спикеры события |
| PUT/DELETE | `/modules/conference/speakers/{id}` | Клиент | Редактировать/удалить спикера |
| GET/POST | `/modules/conference/sessions` | Клиент | Сессии программы |
| GET/POST | `/modules/conference/commercial` | Клиент | Услуги/коммерческие предложения |
| GET/POST | `/modules/conference/secret-codes` | Клиент | Кодовые слова |
| GET/POST | `/modules/conference/promo-partners` | Клиент | Промо-партнёры события |
| GET/POST | `/modules/conference/broadcasts` | Клиент | Рассылки конференции |

---

## Бизнес-логика

### Реферальные ссылки

- Если `points_paid = 0` → участник получает **одну** реферальную ссылку (`ref_code`)
- Если `points_paid > 0` → участник получает **две** ссылки: `ref_code` (бесплатная) и `ref_code_paid` (платная)
- Ссылки: `https://plusson.app/r/{ref_code}` → логирует клик → редиректит на `events.landing_url`

### Механизм конверсии

```
Клик по реф. ссылке → referral_events (type=click) → редирект на лендинг
После регистрации на лендинге → POST /referral/conversion { event_slug, ref_code, type: "free"|"paid" }
→ referral_events (type=free/paid) → начисление баллов участнику-рефереру → проверка порогов подарков
```

Если лендинг не поддерживает webhook → `type=click` сам считается регистрацией → через 20 минут триггер вовлекающей рассылки.

### Начисление баллов и подарков

**Важно: вся операция — одна атомарная транзакция в PostgreSQL (`SELECT FOR UPDATE`).**
Это защищает от race condition когда два webhook приходят одновременно.

1. `BEGIN TRANSACTION`
2. `SELECT * FROM event_participants WHERE id = ? FOR UPDATE` — блокируем строку участника
3. `UPDATE event_participants SET points_total += points_free WHERE id = ?`
4. Для каждого неполученного подарка: `points_total >= gift.points_cost` и `gift.stock != 0`
5. Если условие выполнено → `INSERT INTO gift_issuances` + уменьшить `gift.stock` (если не -1)
6. `COMMIT` → после успеха отправить уведомление участнику
7. При любой ошибке → `ROLLBACK`

### Подписка перед Игрой (опционально)

- Клиент включает `require_subscription = true` и добавляет каналы в `event_subscriptions`
- При открытии Mini App → проверяется `getChatMember(channel_id, tg_user_id)` через Bot API
- Если не подписан → показывается экран «Подпишись, чтобы продолжить»

### Тарифный middleware

- Все запросы клиента проверяются через `TariffMiddleware`
- Клиенты на `beta`: middleware возвращает разрешение на всё
- Будущие тарифы: проверяются лимиты `max_events`, `max_participants`

### Прогресс участника (эндпоинт для Mini App)

`GET /events/{slug}/progress` — вызывает Mini App, авторизация через Telegram initData

Возвращает всё необходимое для отображения вкладки [Игра]:

```json
{
  "participant_id": 42,
  "ref_code": "ABC123",
  "ref_url": "https://plusson.app/r/ABC123",
  "invites_count": 3,
  "points_total": 3,
  "gifts": [
    { "id": 1, "title": "Гайд", "points_cost": 1, "status": "issued", "link_url": "https://..." },
    { "id": 2, "title": "Курс", "points_cost": 5, "status": "in_progress", "link_url": null },
    { "id": 3, "title": "VIP", "points_cost": 10, "status": "locked", "link_url": null }
  ],
  "next_gift": { "title": "Курс", "points_cost": 5, "remaining": 2 }
}
```

**Правило:** `link_url` возвращается только если `status = "issued"`. Для остальных — `null`.

### Прогресс в UI (правила отображения)

- Всегда показывать прогресс в **людях**: «Ты пригласил 3 человека»
- Баллы показывать только если `points_scope = 'client'` (накопительный across событий) или при многоуровневой системе
- В MVP: баллы = технический счётчик, пользователь видит только людей и подарки

---

## Рассылки

### Два типа рассылок

| Тип | Кто создаёт | Как отправляется |
|---|---|---|
| **Автоматические (сегментные)** | Сервис автоматически | После согласования Клиентом — уходят по триггеру |
| **Рассылки модуля «Конференция»** | Клиент создаёт вручную | После согласования Клиентом — уходят по расписанию |

---

### Процесс согласования (для обоих типов)

**Рассылка не уходит автоматически без ведома Клиента.** Схема:

```
Сервис генерирует черновик рассылки (status = 'draft')
→ Клиент видит её в web-кабинете: текст, сегмент/время, кол-во получателей
→ Кнопка «Отправить» или «Редактировать»
→ Клиент нажимает «Отправить» → status = 'approved'
→ Celery отправляет в указанное время
→ После отправки status = 'sent', заполняется sent_at и recipients_count
```

**Поле `status` в `conf_broadcast_messages` и `notifications_log`:**
- `draft` — черновик, ждёт согласования
- `approved` — согласована, ждёт отправки по времени
- `sending` — Celery взял в работу
- `sent` — отправлена
- `cancelled` — отменена Клиентом

**Эндпоинты для согласования:**

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/notifications/drafts?event_id=` | Список черновиков рассылок на согласование |
| POST | `/notifications/{id}/approve` | Клиент нажал «Отправить» → status = approved |
| POST | `/notifications/{id}/cancel` | Клиент отменил рассылку |
| PUT | `/notifications/{id}` | Клиент отредактировал текст черновика |

---

### Автоматические сегментные рассылки

| Сегмент | Триггер | Механика |
|---|---|---|
| `no_game` | Клик по реф. ссылке | В момент клика → создаётся delayed Celery task (eta = now + 20 мин) → перед отправкой проверяем: `activated_at IS NULL` и в `notifications_log` нет отправки этого сегмента → создаётся черновик → ждёт кнопки Клиента |
| `no_share` | Регистрация участника | При `activated_at` → delayed task (eta = now + 24 ч) → проверяем: `referral_events` для этого участника пусты → черновик |
| `stalled` | Новый реферал участника | При первом реферале → delayed task (eta = now + 48 ч) → проверяем: не было новых рефералов за 48 ч → черновик |

**Защита от дублей:** перед созданием черновика всегда проверять `notifications_log` — если запись с `(tg_user_id, event_id, segment)` уже есть → пропустить.

---

### Рассылки модуля «Конференция»

Создаются в разделе «Конференция» web-кабинета. Типы:

| Тип | Когда | Содержание |
|---|---|---|
| `speaker_intro` | За 1 день до сессии спикера | Представление спикера: фото, bio, подарок участникам |
| `pre_30min` | За 30 мин до сессии | «Скоро выступает {имя}» + ссылка на трансляцию |
| `pre_5min` | За 5 мин до сессии | «Уже начинаем!» |
| `day_start` | В день конференции утром | Программа дня |
| `manual` | Вручную, произвольно | Любое сообщение от Клиента |

Все создаются как `status = 'draft'` и требуют нажатия кнопки «Отправить» в web-кабинете.

---

## Telegram Bot — сценарии

| Сценарий | Обработчик | Логика |
|---|---|---|
| `/start ref_{ref_code}` | `bot/handlers/start.py` | Создать/найти telegram_users → создать event_participants с referrer → выдать ссылку |
| `/start` без параметра | `bot/handlers/start.py` | Показать список событий участника или информационное сообщение |
| Проверка подписки | (в разработке) | Кнопка «Подписаться» + «Я подписался» → проверка через getChatMember |

---

## Структура файлов бэкенда

```
backend/
├── app/
│   ├── main.py                   ← FastAPI app, CORS, lifespan, health-check
│   ├── config.py                 ← env-переменные (DATABASE_URL, JWT secret, bot token)
│   ├── database.py               ← asyncpg пул подключений к PostgreSQL
│   ├── middleware/
│   │   └── tariff.py             ← проверка лимитов тарифа
│   ├── api/
│   │   ├── auth.py               ← регистрация/вход клиента и администратора
│   │   ├── events.py             ← CRUD событий
│   │   ├── gifts.py              ← CRUD подарков
│   │   ├── participants.py       ← регистрация и активация участников
│   │   ├── referral.py           ← редирект /r/{ref_code}, webhook конверсии
│   │   ├── admin.py              ← панель администратора
│   │   └── modules/
│   │       └── conference.py     ← спикеры, сессии, рассылки, кодовые слова, промо-партнёры
│   └── services/
│       ├── referral_engine.py    ← генерация кодов, логирование, начисление баллов
│       ├── participant_service.py← управление участниками
│       ├── gift_service.py       ← проверка порогов, выдача подарков
│       └── notification_service.py ← отправка TG-сообщений по сегментам
└── bot/
    ├── main.py                   ← polling режим
    └── handlers/
        └── start.py              ← обработчик /start
```

---

## Переменные окружения (.env)

```
DATABASE_URL=postgresql://plusson:password@localhost:5432/plusson
JWT_SECRET=
BOT_TOKEN=
REDIS_URL=
SERVICE_KEY=          ← секрет для запросов от бота к API
WEBHOOK_SECRET=       ← секрет для входящих webhook от лендингов
```
