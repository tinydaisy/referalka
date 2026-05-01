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
- `landing_url` — ссылка на лендинг события (внешний или встроенный `pluson.app/l/{slug}`)
- `address` — адрес доступа: либо URL стрима/видео, либо офлайн-адрес (одно поле, свободный текст). Опц.
- `description` — описание события (опц.)
- `start_at`, `end_at` — даты начала/конца (опц., могут быть пустыми для бессрочного доступа)
- `webhook_url` — куда клиент вешает ПЛЮСОН-webhook в своей платёжке
- `require_subscription` — требовать подписку на канал перед Игрой
- ⚠️ Все типы мероприятий (вебинар, урок, нетворкинг, эфир) — записи в `events` с разным `module_slug`. Конференции тоже в `events`, плюс расширение в `conf_*`.

**`event_subscriptions`** — каналы для проверки подписки (мессенджер-агностик)
- `event_id`, `platform` (telegram / max), `channel_id`, `channel_title`, `is_required`

### Иерархия Контактов (миграция 036 от 2026-04-26)

Пять связанных таблиц — каждая со своей ролью. Запомнить раз и навсегда:

```
platforms                    ← СПРАВОЧНИК платформ (telegram, vk, max)
    ↑ platform_slug FK
    │
contacts                     ← ЧЕЛОВЕК (Иван Петров)
    ↓ contact_id
platform_users               ← его АККАУНТ на платформе (TG-аккаунт Ивана = tg_id 123456789)
    ↓ platform_user_id
platform_user_channels       ← ПОДПИСКА аккаунта на конкретный канал клиента
    ↑ channel_id
channels                     ← КАНАЛЫ клиента (его TG-боты, VK-группы, MAX-каналы)
```

**Зачем разделять `platform_users` и `platform_user_channels`?**

Один TG-аккаунт может быть в нескольких ботах одного клиента: Маргарита запускает `@pluson_bot` и `@margo_forbs_bot` — Иван подписан на оба. Это одна идентичность (`platform_users`) и две подписки (`platform_user_channels`).

- `platform_users` хранит **кто** (username, first_name, tg_id) — данные аккаунта, не зависят от канала. Иван сменил username → один UPDATE.
- `platform_user_channels` хранит **где состоит** — состояние подписки в каждом боте отдельно (`is_unsubscribed`, `subscribed_at`, `unsubscribed_at`). Отписался от одного бота — на других не влияет.

**Зачем разделять `contacts` и `platform_users`?**

Один человек может прийти и через Telegram, и через VK. Это **один контакт** клиента, но **две разные идентичности на платформах**. Реф-код, email, phone, tags принадлежат человеку — живут в `contacts`. Username и tg_id принадлежат конкретному аккаунту — живут в `platform_users`.

**Зачем отдельная таблица `platforms`?**

Чтобы не хранить `'telegram' / 'vk' / 'max'` как `TEXT` и не порождать ошибки опечаток (`'tg'` вместо `'telegram'`). Plus у платформы есть метаданные: иконка, цвет бренда, лимит длины сообщения, поддержка кнопок/файлов. Все такие поля живут в одном месте, не размазаны по фронту.

---

**`platforms`** — справочник платформ (миграция 036)
- `slug` PRIMARY KEY ('telegram' | 'vk' | 'max') — текстовый PK, читаемо в SQL
- `display_name` — 'Telegram' / 'VK' / 'MAX'
- `icon_url`, `color_hex` — для UI
- `id_format` ('numeric' | 'string') — формат `platform_user_id`
- `max_message_length` — лимит сообщения для рассылок
- `supports_buttons`, `supports_photo`, `supports_video` — фичи платформы
- `api_base_url` — база для запросов
- `is_active`, `sort_order`
- Seed: telegram, vk, max

**`contacts`** — Контакт (человек) per-client (миграция 036)
- `client_id` → привязка к клиенту ПЛЮСОН
- `name`, `email`, `email_normalized`, `phone`, `phone_normalized` — нормализация для автомерджа
- `tags` JSONB, `utm_source`, `salebot_id`, `last_contact_at`
- **`ref_code` UNIQUE** — реф-код человека (один на контакт, не на идентичность)
- **`first_referrer_contact_id`** → `contacts(id)` — кто впервые привёл (ссылка на контакт-реферера)
- `merged_into` → `contacts(id)` — soft-delete при ручном мердже (вторичный контакт ссылается на главный)
- `merged_ref_codes` JSONB — реф-коды слитых контактов (для исторического резолва рефералов)
- `is_active` BOOL — основной флаг
- Один человек = одна запись. Если идентичности на TG и VK — обе ссылаются на один `contacts.id`.

**`platform_users`** — идентичность Контакта на платформе (миграция 036 — переосмыслена)
- `contact_id` → `contacts(id)` — обязательная связь с человеком
- `platform_slug` → `platforms(slug)` — возвращено и завязано на справочник
- `platform_user_id` (TEXT) — внешний id (tg_id / vk_id / max_id; для оргов псевдо `org_X`)
- `username` (без `@`), `first_name`, `last_name` — как они в этой платформе
- `platform_meta` (JSONB) — доп. поля платформы
- UNIQUE(`contact_id`, `platform_slug`) — у контакта одна идентичность на платформу
- UNIQUE(`client_id`, `platform_slug`, `platform_user_id`) — один tg_id у клиента не дублируется
- ⚠️ Удалены (живут в `contacts`): `email`, `phone`, `tags`, `utm_source`, `salebot_id`, `ref_code`, `first_referrer_*`, `last_contact_at`

**`channels`** — каналы доставки клиента (миграция 033, расширено в 036)
- `client_id`, `platform_slug` → `platforms(slug)`, `display_name`, `handle` (@bot / vk_group_id / max_id)
- `bot_token` — секрет канала (переехал из `clients.bot_token`)
- `is_active`
- У одного клиента может быть несколько каналов одной или разных платформ

**`platform_user_channels`** — подписка идентичности на конкретный канал (миграция 033, расширено в 036)
- `platform_user_id` → `platform_users`, `channel_id` → `channels`
- `platform_slug` → `platforms(slug)` — дубль для составного FK
- `is_unsubscribed` (per-канал), `subscribed_at`, `unsubscribed_at`
- UNIQUE(`platform_user_id`, `channel_id`)
- ⚠️ Составные FK на (`platform_user_id`, `platform_slug`) и (`channel_id`, `platform_slug`) — гарантия что платформы совпадают на уровне БД, нельзя подписать TG-аккаунт на VK-группу

### Мердж контактов (автомердж + ручной)

**Автомердж** — при создании новой идентичности (TG /start, импорт Salebot, Event_leads, регистрация на лендинге):
1. Нормализуем `email` (lowercase + trim) и `phone` (только цифры, `8` → `+7`).
2. Ищем `contact` у того же клиента где `email_normalized` совпал ИЛИ `phone_normalized` совпал.
3. Нашли → новая `platform_users` ссылается на найденный `contact_id`. Дозаполняем пустые `name/email/phone` контакта новыми данными.
4. Не нашли → создаём `contact` + `platform_users`.

⚠️ Поиск **только при создании**, не при апдейте. Иначе смена email привяжет идентичность к чужому контакту.

**Ручной мердж** — кнопка «Объединить» в карточке контакта:
1. Клиент выбирает главный контакт (его `name/email/phone` остаются).
2. Все `platform_users.contact_id`, `event_participants.contact_id`, `collaborators.contact_id`, `referrer_*` со второстепенного → главный.
3. Реф-код второстепенного → в `merged_ref_codes` JSONB главного (для исторического резолва).
4. Второстепенный: `merged_into = главный.id`, `is_active = false`.

**В UI** — блок «Возможные дубли»: контакты с тем же ФИО (Левенштейн ≤2) или тем же phone/email (если автомердж не сработал — например, email появился позже).

**`event_participants`** — факт участия (1 строка на каждое событие каждого человека)
- `event_id`, `contact_id` → `contacts(id)` — участвует ЧЕЛОВЕК, не идентичность (миграция 036)
- `referrer_ref_code` — per-event реферер (отличается от `contacts.first_referrer_*`)
- `referrer_participant_id` → реферер в рамках этого события (если реферер сам участник)
- `is_registered` BOOL, `is_in_chat` BOOL
- `registered_at`, `activated_at` (когда открыл Игру)
- ⚠️ Реф-код берётся через JOIN на `contacts.ref_code`, в `event_participants` поля нет
- Резолв реферера: `JOIN platform_users WHERE pu.ref_code = referrer_ref_code` — один путь и для участников, и для спикеров

### Реферальная механика

**Один реф-код на человека** (миграция 032 от 26.04.2026, переехал в contacts миграцией 036):
- Источник истины — `contacts.ref_code` UNIQUE (раньше `platform_users.ref_code`, миграция 036 перенесла на уровень человека)
- Поля `event_participants.ref_code` и `conf_speaker_events.ref_code` УДАЛЕНЫ
- Резолв «по коду найти человека»: `JOIN contacts c WHERE c.ref_code = ?`
- Резолв спикера: `c.ref_code → collaborators.contact_id → conf_speaker_events`
- В `contacts.first_referrer_contact_id` хранится «кто впервые привёл контакт в базу клиента»; в `event_participants.referrer_ref_code` — per-event реферер (один человек на разные события мог прийти от разных)
- Если реф-код был у слитого контакта — резолвится через `contacts.merged_ref_codes` JSONB

**`referral_events`** — лог кликов и конверсий
- `event_id`, `ref_code`, `visitor_tg_id`, `type` (click / free / paid), `points_awarded`, `level`

**`referral_levels`** — настройки многоуровневых баллов (заложено, в MVP не используется)
- `event_id`, `level` (1 = прямой), `points_free`, `points_paid`

### Подарки и материалы

**`gifts`** — подарки реферальной механики (legacy, используется в текущем коде)
- `event_id`, `title`, `description`, `points_cost`, `link_url`, `stock` (-1 = безлимит)

**`gift_issuances`** — выдачи подарков
- `gift_id`, `participant_id`, `status` (pending / issued)

**`materials`** — рекламные материалы события (legacy)
- `event_id`, `title`, `link_url`, `type` (free / paid), `is_eternal`, `status` (active / archived)

**`promo_materials`** — афиши и тексты анонсов (загружаются Клиентом)
- `event_id`, `type` (poster / text_post / text_dm), `content_url`

### Лид-магниты и реф-программа на уровне события (зафиксировано 2026-04-25)

**`lead_magnets`** — общая база лид-магнитов клиента (per-client)
- `id`, `client_id` → `clients`, `name`, `description`, `url`, `created_at`, `updated_at`
- Один лид-магнит = один материал (чек-лист, гайд, статья, видео — что угодно по ссылке)
- Не пакет, без вложенных подарков
- Используется в реф-программе любого события клиента

**`event_posters`** — афиши события (для лендинга, рассылок, шеринга)
- `id`, `event_id` → `events`, `url`, `orientation` ('horizontal' | 'vertical'), `sort`, `created_at`
- Несколько афиш разных ориентаций на одно событие

**`event_referral_settings`** — общие настройки реф-программы события
- `id`, `event_id` → `events` (UNIQUE), `welcome_text` (приветствие со списком всех подарков), `share_text` (текст-анонс для шеринга участником)

**`event_referral_thresholds`** — пороги реф-программы (за сколько друзей какой подарок)
- `id`, `event_id` → `events`, `threshold_count` (1, 3, 10 — кол-во приведённых), `lead_magnet_id` → `lead_magnets`, `certificate_url` (опц., картинка-сертификат), `gift_template_text` (текст выдачи от бота), `sort`
- Защита от двойного начисления — атомарная транзакция при достижении порога

**`event_referral_materials`** — изображения для шеринга в реф-программе
- `id`, `event_id` → `events`, `image_url`, `source` ('event_poster' | 'custom'), `source_poster_id` → `event_posters` (опц., если source='event_poster'), `sort`
- Клиент в Материалах реф-программы может выбрать афишу события или загрузить свою (с надписями типа «я участвую, присоединяйся»)
- Текст-анонс — единый, лежит в `event_referral_settings.share_text`

**`broadcast_log`** — лог всех отправленных сообщений рассылки
- `schedule_id` → `broadcast_schedules`, `platform_user_id` → `platform_users`
- `status` (sent / failed / skipped), `error`, `sent_at`
- ⚠️ `notifications_log` — удалена (была пустой, заменена системой broadcast)

### Модуль «Конференция» (prefix `conf_`)

**`conf_conferences`** — настройки конференции
- `event_id`, `start_date`, `end_date`, `stream_url_day_1/2`, `is_live`, `vip_upsell_url`

**`collaborators`** — глобальная база коллабораторов (НЕ per-client; общая для всей платформы)
- `name`, `title`, `achievements[]`, `photo_url`, `poster_url`, `tg_channel_url`, `tg_channel_id`, `personal_tg_id`, `personal_tg_username`, `assistant_tg_username`, `instagram_url`, `website_url`
- `created_by_client_id` → клиент, который завёл первым
- **`platform_user_id`** → `platform_users(id)` (миграция 032) — каждый коллаб связан с Контактом, и через него — с реф-кодом
- ⚠️ Таблицы `speakers` нет; PK называется `speakers_pkey` исторически, но таблица одна — `collaborators`

**`conf_speaker_events`** — участие коллаборатора в конкретной конференции (Many-to-Many)
- `speaker_id` → `collaborators`, `event_id` → `events`
- `role` (organizer/headliner/commercial/speaker/partner/general_partner)
- `speaker_topic`, `gift_after_speech_title/url`, `gift_raffle_title/url`, `keyword_code`
- `poster_url` — индивидуальная афиша спикера для этого события
- `partner_url`, `extra_info`, `bot_in_channel`, `is_visible`, `sort_order`, `priority`
- `exclude_gift_from_broadcast`, `exclude_channel_from_subscription`
- ⚠️ Удалено: `ref_code` (живёт в `platform_users` через `collaborators.platform_user_id`, миграция 032)
- Реф-код спикера резолвится: `cse → collaborators.platform_user_id → platform_users.ref_code`

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

## Архитектура UI — модульный дашборд (актуально на 2026-04-26)

### Концепция

Дашборд разделён на разделы **БАЗА** (общие per-client сущности) и **СОБЫТИЯ** (модули событий).
Реф-программа — **не отдельный раздел**, а вкладка внутри карточки любого события или конференции.

### Структура навигации (сайдбар)

```
[Логотип]
───────────────
📊 Дашборд
📨 Рассылки
───────────────
БАЗА
  👤 Контакты
  🤝 Коллаборации
  🎁 Лид-магниты
───────────────
СОБЫТИЯ
  📅 Мероприятия (вебинары, уроки, нетворкинги, эфиры)
  🎙 Конференции
───────────────
СКОРО
  🏆 Премии
  🏅 Турниры
───────────────
⚙ Настройки
🆘 Тех.поддержка → @margo_forbs в Telegram
🌐 EN/RU
🚪 Выйти
```

### Роутинг Web-кабинета

| Роут | Что |
|---|---|
| `/dashboard` | Главная |
| `/dashboard/clients` | Контакты (`platform_users` клиента) |
| `/dashboard/collaborations` | Коллаборации (база `collaborators`) |
| `/dashboard/lead-magnets` | Лид-магниты (общая база per-client) |
| `/dashboard/events` | Список мероприятий (всё кроме конференций) |
| `/dashboard/events/new` | Создать мероприятие |
| `/dashboard/events/[id]` | Карточка с вкладками: Основное / Афиши / Реф-программа (Подарки/Материалы/Шаблоны) / Рассылки |
| `/dashboard/conferences` | Список конференций |
| `/dashboard/conferences/new` | Создать конференцию |
| `/dashboard/conferences/[id]` | Карточка с вкладками: Настройки / Спикеры / Программа / Участники / Афиши / Розыгрыш / **Реф-программа** / Отчёт + ссылка «Рассылки» |
| `/dashboard/broadcasts` | Общий раздел рассылок |
| `/dashboard/settings` | Настройки клиента (профиль, bot_token уже из `channels`) |

### Списки (мероприятия и конференции)

- Переключатель **«список / плитки»** в правом верхнем углу, по умолчанию список (выбор сохраняется в `localStorage` per-список)
- В строке: афиша/иконка → название → дата (start_at, fallback `MIN(conf_days.day_date)` для конференций, fallback `created_at`) · кол-во участников → бейдж статуса (только active/ended; «черновик» не показывается)
- Иконка 📋 «Скопировать» — глубокое копирование события (см. `POST /events/{id}/copy`)
- Иконка 🗑 «Удалить»
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
| GET | `/events/` | Клиент | Список своих событий (с `effective_start_at` — fallback для конф.) |
| POST | `/events/` | Клиент | Создать событие (поддерживает address, start_at, end_at) |
| GET | `/events/{id}` | Клиент | Карточка события + метрики |
| PATCH | `/events/{id}` | Клиент | Редактировать событие |
| DELETE | `/events/{id}` | Клиент | Удалить событие |
| **POST** | **`/events/{id}/copy`** | Клиент | **Глубокое копирование события: дублирует event + posters + реф-программу + (для конф.) все conf_* + broadcast_templates. Возвращает новое событие со статусом `draft`** |
| GET | `/events/{id}/analytics` | Клиент | Метрики события + топ рефереров |
| GET | `/events/{id}/participants` | Клиент | Таблица участников |

### Лид-магниты (`/lead-magnets`) — общая база per-client

| Метод | Путь | Что |
|---|---|---|
| GET | `/lead-magnets` | Список лид-магнитов клиента |
| POST | `/lead-magnets` | Создать (name, description, url) |
| GET | `/lead-magnets/{id}` | Получить |
| PATCH | `/lead-magnets/{id}` | Обновить |
| DELETE | `/lead-magnets/{id}` | Удалить (связанные пороги получат NULL вместо подарка) |

### Реф-программа события (`/events/{id}/...`)

**Афиши:**
| Метод | Путь | Что |
|---|---|---|
| GET | `/events/{id}/posters` | Список афиш |
| POST | `/events/{id}/posters` | Добавить (url, orientation: horizontal\|vertical, sort) |
| PATCH | `/events/{id}/posters/{poster_id}` | Обновить |
| DELETE | `/events/{id}/posters/{poster_id}` | Удалить |

**Настройки реф-программы:**
| Метод | Путь | Что |
|---|---|---|
| GET | `/events/{id}/referral/settings` | welcome_text, share_text, **gift_count_mode** ('registered'\|'visited', миграция 042) |
| PUT | `/events/{id}/referral/settings` | Upsert |

**Розыгрыш на событии (миграция 042):**
| Метод | Путь | Что |
|---|---|---|
| GET | `/events/{id}/raffle/settings` | Настройки розыгрыша (is_enabled, draw_at, subscription_grants_starter_ticket, intro_text) |
| PUT | `/events/{id}/raffle/settings` | Upsert настроек |
| GET | `/events/{id}/raffle/prizes` | Список призов |
| POST | `/events/{id}/raffle/prizes` | Добавить приз (title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active) |
| PATCH | `/events/{id}/raffle/prizes/{prize_id}` | Обновить приз |
| DELETE | `/events/{id}/raffle/prizes/{prize_id}` | Удалить |
| GET | `/events/{id}/raffle/keywords` | Список кодовых слов |
| POST | `/events/{id}/raffle/keywords` | Добавить (keyword, sort_order, is_active). `max_uses`/`used_count` дропнуты миграцией 054, `tickets_reward` — миграцией 055. Одно слово = ровно один билет участнику. Слово может ввести любое число участников |
| PATCH | `/events/{id}/raffle/keywords/{kw_id}` | Обновить |
| DELETE | `/events/{id}/raffle/keywords/{kw_id}` | Удалить |

**VIP-тариф и Чат события (миграция 042):**
Поля передаются через стандартный `PATCH /events/{id}` (UpdateEventRequest):
- `has_vip_tariff` BOOL, `vip_price` INT, `vip_url`, `vip_title`, `vip_description`
- `chat_url`, `chat_subscriptions_required` BOOL, `chat_member_count_label`
- `successor_event_id` (миграция 039)

**Бренд клиента (миграция 042):**
Передаётся через `PATCH /clients/me/profile`:
- `brand_name` — название бренда (например `iVISION`), отображается в Экосистеме
- Существующие поля визитки: `bio`, `profile_photo_url`, `positioning` (роль владельца), `achievements` JSONB (4 регалии {label,value}), `social_links` JSONB

**Пороги-подарки:**
| Метод | Путь | Что |
|---|---|---|
| GET | `/events/{id}/referral/thresholds` | Список с JOIN на lead_magnets |
| POST | `/events/{id}/referral/thresholds` | Добавить (threshold_count, lead_magnet_id, certificate_url, gift_template_text) |
| PATCH | `/events/{id}/referral/thresholds/{tid}` | Обновить |
| DELETE | `/events/{id}/referral/thresholds/{tid}` | Удалить |

**Материалы для шеринга:**
| Метод | Путь | Что |
|---|---|---|
| GET | `/events/{id}/referral/materials` | Список |
| POST | `/events/{id}/referral/materials` | Добавить (image_url, source: event_poster\|custom, source_poster_id) |
| DELETE | `/events/{id}/referral/materials/{mid}` | Удалить |

**Импорт реф-программы из другого события:**
| Метод | Путь | Что |
|---|---|---|
| GET | `/events/{id}/referral/import-sources` | События клиента у которых есть реф-программа |
| POST | `/events/{id}/referral/import` | `{from_event_id}` — затирает текущую реф-программу и копирует из выбранной |

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
