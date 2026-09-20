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

**`tariffs`** — тарифные планы (миграции 067-072 от 07.05.2026)
- `slug`, `name`, `price`, `contact_limit`, `broadcasts_daily_limit` (NULL=безлимит), `default_duration_days`
- Текущие тарифы: `trial` (60 дн, 0 ₽, всё), `start` (30 дн, 990 ₽, lead_magnets), `pro` (30 дн, 2490 ₽, +conference/awards), `vip` (30 дн, 3900 ₽, всё+channels+export)
- ⚠️ **Удалены** колонки `allow_custom_bot`, `trial_months`, `max_events`, `max_participants` — заменены фичами и подписками

**`features`** — справочник опций тарифа (миграция 067)
- `slug` (`channels`, `conference`, `awards`, `lead_magnets`, `export_contacts`, `tournaments`, `broadcast_chats`), `name`, `description`, `sort`
- **Поля модуля-аддона (миграция 165):** `is_addon` BOOL, `price_monthly`, `price_6mo`, `min_tariff_slug`, `tagline`, `bullet_points` JSONB, `prodamus_payment_url`, `prodamus_payment_url_6mo`. **Миграция 172:** `promo_old_monthly`, `promo_old_6mo` — старая зачёркнутая цена для акции.

**`tariff_features (tariff_id, feature_id)`** — junction many-to-many (миграция 068). Какие фичи входят в какой тариф.

**`client_addons` / `addon_orders` (миграция 165)** — модули-аддоны, докупленные клиентом поверх тарифа (Продамус). `client_has_feature` = фича в тарифе ИЛИ активный аддон. Модули-аддоны: `collab_hub` (1000₽ акция / ~~2000~~), `conference` (3000₽), `tournaments` (5000₽), доступны при тарифе Профи+. **Актуальные тарифы:** trial 0, start 990 «Стандарт» (скрыт), pro 1990 «Профи», vip 2990 «Экстра».

**`client_subscriptions`** — подписки клиентов (миграция 069)
- `client_id`, `tariff_id`, `started_at`, `expires_at`, `status` (active/expired/paused), `source` (paid/trial/admin/promo)
- `notified_7d/3d/1d` BOOL — идемпотентность уведомлений за 7/3/1 день
- Активная подписка: `status='active' AND expires_at > NOW()`. Истечение → `expired`, future broadcasts → `paused_subscription_expired`

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
- Поля `event_participants.ref_code` и `conf_speaker_events.ref_code` УДАЛЕНЫ (самой таблицы `conf_speaker_events` тоже нет — см. `event_collaborators` ниже)
- Резолв «по коду найти человека»: `JOIN contacts c WHERE c.ref_code = ?`
- Резолв спикера: `c.ref_code → collaborators.contact_id → event_collaborators`
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
- `id`, `client_id` → `clients`, `name`, `description`, `url`, **`slug` UNIQUE** (миграция 062), `created_at`, `updated_at`
- Один лид-магнит = один материал (чек-лист, гайд, статья, видео — что угодно по ссылке)
- `slug` — 5-символьный код (алфавит без 0/o/1/l/i), используется в публичной ссылке `pluson.ru/m/{slug}`
- Используется в реф-программе любого события клиента и в воронке выдачи (см. ниже)

**`lead_magnet_packages`** — пакеты лид-магнитов (миграция 062)
- `id`, `client_id`, `name`, `description`, `slug` UNIQUE, `created_at`, `updated_at`
- Объединение нескольких лид-магнитов под одним названием и публичной ссылкой `pluson.ru/p/{slug}`
- Slug-неймспейс общий с `lead_magnets` (один и тот же `slug` не может одновременно быть и магнитом, и пакетом)

**`lead_magnet_package_items`** — состав пакета (M2M)
- `package_id`, `lead_magnet_id`, `sort_order`, PK(package_id, lead_magnet_id)
- ON DELETE CASCADE с обеих сторон

**`funnel_templates`** — шаблоны воронок выдачи (миграция 063)
- `id`, `client_id`, `type` ('lead_magnet'), `text_1`, `button_label`, `text_2`, `text_3_delivered`, `text_3_stuck`, timestamps
- UNIQUE (client_id, type) — один шаблон на клиента+тип, auto-create при первом GET с дефолтными текстами

**`funnel_runs`** — забеги воронок (миграция 063)
- `id`, `client_id`, `type` ('lead_magnet'), источник: ровно один из `lead_magnet_id` / `package_id`
- Кто пришёл: `contact_id`, `platform_slug`, `platform_user_id`
- Кто привёл: `referrer_contact_id` (резолвится из `?pid=ref_code`)
- Метки: `utm` JSONB, `stage` ('landed' / 'started' / 'subscribed' / 'delivered'), `landed_at`, `started_at`, `subscribed_at`, `delivered_at`, `text3_sent_at`, `text3_kind`
- UNIQUE (client_id, platform_slug, platform_user_id, lead_magnet_id) и аналогично для package — один человек, одна воронка по магниту

**`clients.notifications_telegram_chat_id`** (миграция 063)
- BIGINT NULL — chat_id Telegram-канала клиента, куда @pluson_bot шлёт уведомления о новых интересантах. NULL = не настроено, не шлём.

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
- Реальные колонки (сверено с продом 2026-08-14): `id`, `name`, `title`, `achievements`, `photo_url`, `photo_folder_url`, `video_folder_url`, `video_url`, `tg_channel_url`, `tg_channel_id` (⚠️ тип **character varying**, не integer), `vk_url`, `vk_channel_id`, `max_url`, `max_channel_id`, `instagram_url`, `website_url`, `assistant_tg_username`, `contact_id`, `linked_client_id`, `access_code`, `media_assets`, `ask_topics`, `show_ask_topics_field`, `created_by_client_id`, `created_at`, `updated_at`
- ⚠️ **`platform_user_id` в `collaborators` НЕТ** — связь с человеком идёт через **`contact_id` → `contacts(id)`** (NOT NULL с миграции 086)
- ⚠️ **`personal_tg_id` / `personal_tg_username` УДАЛЕНЫ** — личные аккаунты живут в `platform_users` через `contact_id`
- ⚠️ **`external_ref_param` перенесён на `contacts`** миграцией 103 — в `collaborators` его больше нет
- ⚠️ `poster_url` УДАЛЕНА миграцией 121 — афиши в таблице `collaborator_posters` (библиотека на коллаба)
- ⚠️ Колонки `hub_*` и `is_published_in_hub` **дропнуты миграцией 218** — карточка Коллабораторной живёт в `clients`
- ⚠️ Таблицы `speakers` нет; PK называется `speakers_pkey` исторически, но таблица одна — `collaborators`

**`event_collaborators`** — участие коллаборатора в конкретном событии (Many-to-Many)
> ⚠️ **Раньше в этой документации таблица ошибочно называлась `conf_speaker_events`. Такой таблицы НЕ СУЩЕСТВУЕТ** — и никогда не появится. В SQL использовать только `event_collaborators`. В коде переменные для её id часто зовутся `cse_id`/`ec_id` — это одно и то же.
- `speaker_id` → `collaborators`, `event_id` → `events`
- `role` (organizer/jury/headliner/speaker/general_partner/partner)
- `speaker_topic`, `notes`, `keyword_code`, `gift_raffle_title`, `gift_raffle_url`
- ⚠️ **`gift_after_speech_title/url` УДАЛЕНЫ 2026-07-30** — подарки после эфира переехали в `event_collaborator_lead_magnets` (`ec_id`, `lead_magnet_id`, `package_id`, `manual_title`, `manual_url`, `sort_order`); прежние имена остались только полями JSON-ответа кабинета спикера
- `gift_lead_magnet_id`, `gift_package_id`, `show_gift_after_speech_field`, `exclude_gift_from_broadcast`
- `poster_id` FK на `collaborator_posters` (ON DELETE SET NULL, миграция 121) — какая афиша из библиотеки используется в этом событии. NULL = первая из библиотеки. `use_photo_instead_of_poster` (миграция 237) — в этом событии вместо афиши брать фото коллаба
- `is_visible`, `sort_order`, `priority`, `is_commercial`, `bot_in_channel`, `exclude_channel_from_subscription`
- `knowledge_base_title`, `knowledge_base_url`, `show_topic_field`, `show_knowledge_base_field`, `show_notes_field`
- ⚠️ Удалено: `ref_code` (миграция 032). Реф-код спикера резолвится так: `event_collaborators.speaker_id → collaborators.contact_id → contacts.ref_code`

**`collaborator_posters`** (миграция 121) — библиотека афиш коллаба
- `id`, `collaborator_id` → `collaborators(id)` (CASCADE), `url`, `label`, `sort_order`, `created_at`
- Индекс на `(collaborator_id, sort_order, id)` — для быстрого ORDER BY fallback
- CRUD: `GET/POST/PATCH/DELETE /api/v1/collaborators/{id}/posters` + `POST /reorder`
- DELETE удаляет файл из R2 и запись в `client_files`. ON DELETE SET NULL для `event_collaborators.poster_id` — события автоматически перейдут на fallback
- Загрузка через `POST /api/v1/uploads { kind: 'speaker_poster', collaborator_id }` — авто-INSERT в библиотеку (без отдельного POST на CRUD), ответ дополняется `poster_id`

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
| `conference` | Конференция | conf_conferences, collaborators, event_collaborators, conf_sessions, conf_days, conf_stages, ... |
| `award` | Премия | award_* (будущее) |
| `tournament` | Турнир | tournament_* (будущее) |

---

## Изменения схемы 2026-06-26/27

- **Удалено `events.telegram_chat_ids`** (миграция 171) — legacy CSV «ID Telegram-каналов». «Проверить чаты» теперь по **`events.tg_chat_ref`** (⚠️ колонки `events.tg_chat_id` не существует; рядом `vk_chat_ref`, `max_chat_ref`, тип integer).
- **`client_broadcast_chats`** (миграции 170, 172) — база чатов клиента для рассылок: `client_id, platform, chat_id, title, chat_url, is_public, added_via, is_active, use_for_broadcasts`. `UNIQUE(client_id, platform, chat_id)`. Флаги `broadcast_templates.send_to_client_chats` + `broadcast_schedules.send_to_client_chats`. Гейт по фиче `broadcast_chats` (⚠️ сейчас привязана к `trial`, `pro` и `vip` — не только к Экстре; сверено с прод-базой 2026-08-30).
- **`clients.default_link_mode`** (миграция 169, `miniapp|bot`) + `start_mode`, `start_event_id`, `start_greeting_text`, `start_btn_events_label`, `start_btn_owner_label` — настройка куда ведут публичные ссылки/кнопки бота + приветствие /start.
- **`tournament_packages.scheme`** (миграция 168, `s1|s2|s3|s4`) — схема расчёта пакета вместо normalize+aggregate.
- **Тип критерия «авто-число»** (миграция 173): `tournament_criteria.scorer='auto_number'`, `auto_kind='replace'|'sum'` — число из кодовой фразы в чате.
- **Подарок спикера** (миграция 167): `collaborators.linked_client_id`, `event_collaborators.gift_lead_magnet_id`/`gift_package_id` — лид-магнит из ПЛЮСОНа как подарок (взаимоисключающе с ручным `gift_after_speech_*`).
- **Системный @pluson_bot убран из клиентских флоу** (коммиты 745eb1f, 143e6f2) — только свой VIP-бот клиента; системным остаётся email + регистрация нового клиента + дебаг-алерт + polling @pluson_bot для лички.

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
| GET | `/lead-magnets` | Список лид-магнитов клиента (включая `slug`) |
| POST | `/lead-magnets` | Создать (name, description, url). Slug генерится автоматически. |
| GET | `/lead-magnets/{id}` | Получить |
| PATCH | `/lead-magnets/{id}` | Обновить |
| DELETE | `/lead-magnets/{id}` | Удалить (связанные пороги получат NULL вместо подарка) |
| GET | `/lead-magnets/{id}/analytics` | Аналитика воронки: 3 счётчика + список интересантов |

### Пакеты лид-магнитов (`/lead-magnet-packages`) — миграция 062

| Метод | Путь | Что |
|---|---|---|
| GET | `/lead-magnet-packages` | Список пакетов клиента (с `items[]`) |
| POST | `/lead-magnet-packages` | Создать (name, description, items: [{lead_magnet_id, sort_order}]) |
| GET | `/lead-magnet-packages/{id}` | Получить с составом |
| PATCH | `/lead-magnet-packages/{id}` | Обновить (полная замена `items`) |
| DELETE | `/lead-magnet-packages/{id}` | Удалить |
| GET | `/lead-magnet-packages/{id}/analytics` | Аналитика воронки пакета |

### Воронки выдачи лид-магнитов (миграция 063)

**Шаблоны воронок (`/funnel-templates/{type}`)** — авторизованные:

| Метод | Путь | Что |
|---|---|---|
| GET | `/funnel-templates/lead_magnet` | Текущий шаблон клиента (auto-create при первом GET с дефолтными текстами) |
| PATCH | `/funnel-templates/lead_magnet` | Обновить любой из 5 полей: `text_1`, `button_label`, `text_2`, `text_3_delivered`, `text_3_stuck` |

**Публичный landing (без авторизации):**

| Метод | Путь | Что |
|---|---|---|
| GET | `/m/{slug}` | Landing для одиночного лид-магнита: пишет `funnel_runs` со stage=landed (UTM, `pid` → реф-код партнёра) → 302 на `t.me/<bot>?start=fnl_<run_id>` |
| GET | `/p/{slug}` | То же для пакета |

`<bot>` = бот клиента, если у него активная подписка с фичей `channels` (миграция 067-072) и подключён собственный telegram-канал. Иначе — общий @pluson_bot.

**Bot-флоу** (`backend/bot/handlers/start.py` + `funnel.py`):
1. `/start fnl_<run_id>` → `funnel_service.run_started`: создаёт contact/platform_user если новый, ставит `stage=started`, шлёт уведомление организатору в `clients.notifications_telegram_chat_id`, отправляет Текст 1 + кнопку «ГОТОВО».
2. Callback `fnl_check_<run_id>` → `run_check_subscription`: вызывает `getChatMember` на канал из `clients.social_links.telegram`. Если подписан — ставит `stage=delivered`, шлёт Текст 2 со списком ссылок, шедулит Celery-задачу на 30 минут. Если нет — отвечает «Не вижу подписки».
3. Через 30 минут (`app.tasks.funnel.send_text_3`) — Текст 3: версия `delivered` для получивших, `stuck` для зависших.

**Канал уведомлений** (`clients.notifications_telegram_chat_id`):
- Уведомления всегда шлёт @pluson_bot (даже для VIP).
- Клиент добавляет @pluson_bot админом в свой служебный канал, пересылает любое сообщение из канала в @pluson_bot, бот отвечает chat_id (handler `/getchatid` или ловит `forward_from_chat`).

**Multi-bot polling** (`backend/bot/main.py`): один процесс держит polling для @pluson_bot (settings.telegram_bot_token) + всех ботов клиентов из `channels.bot_token` где `client_channels.is_active=TRUE`, `channels.is_system=FALSE`, и у клиента активна подписка с фичей `channels` (EXISTS на `client_subscriptions` + `tariff_features` + `features`). Все боты разделяют те же handlers — резолв клиента идёт через `funnel_runs.run_id`.

**Плейсхолдеры в шаблоне воронки** (подставляются в момент отправки):
- `{materials_list}` — нумерованный список названий «1. ...» «2. ...» (text_1)
- `{materials_with_links}` — «1. Название — <ссылка>» (text_2)
- `{client_brand_name}` — `clients.brand_name || clients.name`
- `{client_owner_name}` — ⚠️ **колонки `clients.owner_name` НЕ существует**. Имя основателя берётся из **`clients.name`** (`SELECT name AS owner_name` в [funnel_service.py](../backend/app/services/funnel_service.py))
- `{client_owner_achievements}` — `clients.owner_achievements` JSONB форматирован «• label: value»
- `{subscription_channel}` — `@username` из `clients.social_links.telegram`
- `{owner_telegram}` — то же (для упоминания в Тексте 3)

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

### Subscription middleware (миграции 067-072)

- [`app/middleware/subscription_guard.py`](backend/app/middleware/subscription_guard.py) — глобальный middleware
- На POST/PATCH/PUT/DELETE проверяет наличие активной подписки клиента (по JWT.sub)
- Если подписки нет / истекла → 403 «Подписка истекла, продлите тариф для возобновления работы.»
- GET всегда пропускается (просмотр интерфейса разрешён даже при истёкшей подписке)
- Пропускает по префиксам: `/api/v1/auth/`, `/admin/`, `/public/`, `/integrations/`, `/participants/`, `/event/`, `/r/`, `/m/`, `/p/`, `/health`
- Админ (JWT.role='admin') пропускается всегда

**Гард фич** (для конкретных эндпоинтов):
- `app/services/features.py:client_has_feature(db, client_id, slug)` — bool
- `_assert_can_use_custom_bot` в `api/channels.py` использует это для гарда фичи `channels`

**Cron-таски подписок** (`app/tasks/subscriptions.py`, beat schedule):
- `expire_overdue` (раз в час) — `UPDATE client_subscriptions SET status='expired'` где `expires_at <= NOW()` + ставит `paused_subscription_expired` всем `broadcast_schedules` этих клиентов с `fire_at > NOW()`.
- `notify_expiring` (раз в час) — за 7/3/1 день до истечения шлёт сообщение в `clients.notifications_telegram_chat_id` через @pluson_bot. Идемпотентность через флаги `notified_7d/3d/1d` на подписке.

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

---

## Свои домены клиента (миграция 270, ПРОД 2026-08-07)

### Таблица `client_domains`

| Колонка | Что |
|---|---|
| `client_id` | владелец |
| `kind` | `landing` — публичные страницы; `mail` — адрес отправителя писем |
| `domain` | нормализованный домен, `UNIQUE(domain, kind)` |
| `status` | `pending` → `dns_ok` → `active`, либо `error` |
| `is_primary` | один основной домен каждого вида на клиента (частичный UNIQUE) |
| `dns_ok` / `dns_checked_at` / `dns_details` | результат последней проверки DNS |
| `cert_issued_at` / `cert_expires_at` / `cert_name` | сертификат (только `landing`) |
| `dkim_selector` / `dkim_public_key` | DKIM (только `mail`); приватный ключ — на сервере |
| `mail_from_local` / `mail_from_name` | адрес и имя отправителя |
| `last_error` / `last_error_at` | диагностика |

Доступ — фича `custom_domain`.

### Эндпоинты `/api/v1/clients/me/domains`

| Метод | Что делает |
|---|---|
| `GET /` | список доменов + что прописать в DNS |
| `POST /` | добавить домен (для `mail` сразу генерит DKIM-ключ) |
| `POST /{id}/check-dns` | проверка CNAME (landing) или SPF/DKIM/DMARC (mail) |
| `POST /{id}/issue-cert` | выпуск сертификата; доступен только при `dns_ok` |
| `PATCH /{id}` | адрес и имя отправителя (только `mail`) |
| `DELETE /{id}` | отключить домен |

Правки — только владелец кабинета (ассистенту 403).

### Правила

- Публичные ссылки — только через `client_public_url` / `client_public_link` / `public_url_for`. Литералов домена в коде быть не должно.
- Ссылки на платформу (регистрация клиента, дашборд, Mini App, вебхуки платёжек) — `platform_base_url()`.
- Сертификаты только RSA (`--key-type rsa`), иначе часть аудитории не откроет сайт.
- Выпуск сертификата и генерация DKIM требуют root → только API-процесс, не Celery.
- Новый публичный маршрут — дописать в `deploy/nginx-public-locations.conf`.

## Гейт платных модулей (миграция 276)

`services/module_access.py` — `module_write_allowed_by_event(db, event_id)`: у владельца события (`event_owners status='accepted'`) проверяется фича модуля (`conference` / `tournaments`) через `client_has_feature`.

- Чтение своих данных — всегда разрешено.
- Запись — 403 без модуля.
- Публичные эндпоинты для участников — не гейтятся.
- `GET /public/speaker-cabinet/me` и `GET /public/tournament-jury/me` отдают `can_edit` для плашки во фронте.
- Celery `app.tasks.addon_expiry.notify_expiring_addons` — предупреждения за 7/3/1 день, раз в час.

### Правила

- Гейт ставится по тому, КТО зовёт, а не по типу запроса — не размазывать проверку по эндпоинтам, звать общий хелпер.
- Новый пишущий эндпоинт модуля — сразу под гейт, иначе платная функция работает мимо оплаты.
- `can_edit` во фронте трактуется как `!== false`: старый бэк поля не отдаёт.
- Три эндпоинта отправки в Telegram требуют заголовок `X-Integration-Token`.

## Платёжная система клиента: Т-Банк (миграция 277)

`POST https://securepay.tinkoff.ru/v2/Init` → `PaymentURL`. Вебхук — `/api/v1/integrations/client-pay/tbank`.

Поля `clients`: `pay_tbank_terminal_key`, `pay_tbank_password`, `pay_tbank_test_terminal_key`, `pay_tbank_test_password`, `pay_tbank_test_mode`, `pay_tbank_taxation`, `pay_tbank_vat`.

### Правила

- Сумма в копейках, считать через `Decimal` — `float` теряет копейку.
- Подпись: SHA-256 от значений, отсортированных по ключу, + `Password`; вложенные объекты (`Receipt`, `DATA`) исключаются, поэтому `Receipt` кладётся в тело после расчёта.
- Выбор пары ключей — только через `tbank_keys(client)`, одна точка на все вызовы.
- Вебхук проверяется обоими паролями; оплачено = `Status=CONFIRMED` при `Success=true`; в ответ вернуть ровно `OK` текстом.
- «Т-Чеки» — не отдельная система, а фискализация поверх эквайринга: от нас только `Receipt`, чек выдаёт банк.

## Бонус ПЛЮСОНа за оплату тарифа события (миграции 307-311)

**Таблицы**

| Таблица / колонка | Что |
|---|---|
| `event_tariffs.bonus_feature_id` | какой платный МОДУЛЬ дарим (FK `features`), NULL = без модуля |
| `event_tariffs.bonus_days` | срок бонуса **в днях** (мигр. 308). `bonus_months` — легаси |
| `event_tariffs.bonus_trial` | дарить доступ в ПЛЮСОН (доступно ВСЕМ клиентам) |
| `event_tariffs.bonus_tariff_slug` | `trial` или `pro` — что дарим вместе с модулем (только admin) |
| `event_tariffs.bonus_line_auto` | писать строку «Бонус:» на лендинге автоматически |
| `plusson_bonus_coupons` | что человеку положено и активировал ли он (`activated_at`), токен + хеш, `expires_at`, `reminders_sent` |
| `tariff_bonus_grants` | журнал выдач (мигр. 307) |

**Эндпоинты**

| Метод | Путь | Что |
|---|---|---|
| GET | `/bonus/{token}` | активация: заводит кабинет, включает подписку и модуль, отсчёт с этого момента. HTML, без авторизации |
| GET | `/api/v1/events/{id}/tariffs-bonus-features` | справочник модулей для селектора (пусто без фичи) |

**Правила**

- Оплата **не выдаёт доступ** — создаёт купон и шлёт письмо. Отсчёт дней идёт с перехода по ссылке.
- Ссылка одноразовая (`activated_at`), живёт 90 дней.
- Кабинета нет → полный период (база тарифа `trial` + бонус за реферала из админки). Кабинет есть → 3 дня продления **его** тарифа.
- Гейт `tariff_plusson_bonus` — только на платный модуль и тариф «Профи». Триал раздают все клиенты.
- Проверка прав стоит и в POST, и в PATCH тарифа: иначе обходится правкой существующего.
- Цифры дней — из настроек ([plusson_bonus_days.py](backend/app/services/plusson_bonus_days.py)), не хардкод.
- Тексты — одно место ([plusson_bonus_texts.py](backend/app/services/plusson_bonus_texts.py)) на письмо и боты.
- Напоминания: 3, 14, 30, 60 день + за 7 и за 1 день. Счётчик `reminders_sent` (задача бежит раз в час).


---

## Обработка заявок из анкет + CRM (миграции 337–340, 02.09.2026)

### Таблицы

| Что | Где |
|---|---|
| `survey_questions.filled_by` | `visitor` \| `staff` — кто заполняет вопрос |
| `survey_questions.is_protected` | системное поле, удалять нельзя (сейчас «Обработано») |
| `surveys.table_settings` JSONB | какие столбцы видны в таблице заявок, общая на анкету |
| `analytics_dashboards.survey_id` | привязка дашборда к анкете (рядом с `event_id`) |
| `analytics_dashboards.layout` | `cards` \| `columns` — вид показа |

Миграция 337 — восстановление DDL, накаченного когда-то мимо миграций:
`event_participants.is_registered` / `is_in_chat` / `entry_link` и фича `surveys`.

### Эндпоинты

| Метод + путь | Что делает |
|---|---|
| `PUT /surveys/{id}/responses/{rid}/staff-answers` | отметки сотрудника по заявке; пишет ТОЛЬКО в поля `filled_by='staff'` |
| `GET /surveys/{id}/responses` | таблица заявок: `sort`, `dir`, `q`, `processed`, `filters`, `limit`, `offset`; отдаёт `{responses, total}` |
| `GET /events/{id}/crm` | четыре колонки людей по этапам события |
| `GET /lead-magnets/{id}/crm` | колонки воронки лид-магнита (2 или 3) |
| `GET /lead-magnet-packages/{id}/crm` | то же для пакета |
| `GET /analytics/dashboards?survey_id=` | дашборды одной анкеты |
| `GET /analytics/sources?survey_id=` | разрезы, суженные до вопросов одной анкеты |

### Правила доступа

- Обработка заявок (`staff-answers`) — **разрешена помощнику**: ради неё его и заводят. Закрыта у него правка самих анкет и вопросов.
- CRM события — **всем тарифам**, без гейта по фиче.
- Анкеты — фича `surveys`, дашборды — `analytics_dashboard` (обе: Экстра + admin).
- В коллаб-событии CRM отдаёт только контакты **текущего** клиента (`contacts.client_id`).

---

## Автонастройка Telegram «под ключ» — разовая услуга (миграция 364, 07.09.2026)

⚠️ **Ещё не на проде** — миграция написана, не накачена.

Клиент платит **790 ₽** один раз (карточка LeadPay `66205`), и за него делают базовую настройку Telegram: создают бота, привязывают Mini App, заводят закрытую группу уведомлений, прописывают всё в кабинете, передают права. Гейт — фича `tg_autosetup`, пока только `admin`.

### Таблицы

**`services`** — каталог разовых услуг: `slug` UNIQUE, `name`, `tagline`, `description`, `bullet_points` JSONB, `price` (рубли), `coming_soon`, `is_active`, `require_feature`, `leadpay_product_id`, `prodamus_payment_url`, `sort`.

**`tg_setup_accounts`** — живые Telegram-аккаунты (Telethon), от лица которых создаются боты: `phone` UNIQUE, `title`, `username`, `tg_user_id`, `twofa_password`, `proxy`, `session_path`, `max_slots` (по умолчанию 5), `is_active`, `health` (`ok|limited|dead|unknown`), `health_note`, `health_checked_at`.

**`service_orders`** — заказ И состояние процесса в одной строке: `client_id`, `service_id`, `amount`, `status` (`created|paid|failed|cancelled`), `payment_*`, `setup_state` (`new|queued|running|awaiting_user|done|expired|failed`), `setup_error`, `setup_log` JSONB, `bot_username`, `bot_title`, `setup_account_id`, `bot_token`, `bot_channel_id`, `group_chat_id`, `group_invite_link`, `client_tg_user_id`, восемь отметок шагов (`bot_created_at` … `channel_linked_at`), `claim_deadline`, `reminders_sent`.

⚠️ **Своя пара таблиц, а не `client_addons`:** у аддона есть срок (`expires_at`, `months`), а у разовой услуги его нет — иначе у клиента «истекала бы настройка».

⚠️ **Заказ и процесс — одна строка:** у услуги ровно один прогон, разносить на две таблицы значило бы джойнить их на каждом экране ради связи 1:1.

### Эндпоинты

| Метод + путь | Что делает |
|---|---|
| `GET /clients/me/tg-autosetup` | услуга, активный заказ, место в очереди, подсказки имени бота |
| `POST /clients/me/tg-autosetup/check-name` | свободен ли ник бота — спрашиваем у BotFather ДО оплаты |
| `POST /clients/me/tg-autosetup/start` | запуск: новый заказ + ссылка на оплату, либо бесплатный перезапуск оплаченного |
| `POST /integrations/leadpay/service-webhook` | оплата услуги (LeadPay), префикс `svc-` |
| `POST /integrations/prodamus/service-webhook` | оплата услуги (Продамус) |
| `GET /public/services` | публичный каталог услуг (для витрины и лендинга) |
| `GET/POST/PATCH/DELETE /admin/tg-setup/accounts[/{id}]` | сервисные аккаунты |
| `POST /admin/tg-setup/accounts/{id}/session` | загрузка файла сессии Telethon (multipart) |
| `POST /admin/tg-setup/accounts/{id}/check` | проверка вживую: @SpamBot + число ботов |
| `GET /admin/tg-setup/orders` | все заказы |
| `POST /admin/tg-setup/orders/{id}/{retry\|mark-paid}` | вернуть в очередь / отметить оплаченным |
| `GET/PATCH /admin/tg-setup/services[/{slug}]` | цена, «СКОРО», карточка оплаты |

### Правила

- **Оплата разовая**, префикс номера заказа **`svc-`** (рядом с `evt-`, `prd-`, `addon-`).
- **Очередь по слотам**: слот занимает непереданный бот, освобождает — передача клиенту.
- **Услуга оказана, когда бот создан.** Не забрал за 3 дня — бот удаляется, слот освобождается, оплата сохраняется (перезапуск бесплатный).
- **Только `health='ok'`** аккаунты берутся в работу: спам-блок запрещает и создание ботов.
- **Передача бота** требует: двухфакторка ≥7 дней, `/start` от получателя, облачный пароль.
- **ID клиента** узнаётся только из его захода в бота — иначе неоткуда.
- Ассистенту запись закрыта общим middleware; админские эндпоинты — по роли админа платформы.

---

## Точка лица на фото + генератор афиш (миграции 434–436, 2026-09-18)

### Таблицы и колонки

| Что | Где |
|---|---|
| `photo_focal`, `cutout_photo_focal` | `collaborators` — точка лица у ОСНОВНОГО фото и у вырезки (они кадрированы по-разному) |
| `focal` | `client_speaker_photos` — у каждого снимка библиотеки своя |
| `owner_photo_focal`, `profile_photo_focal` | `clients` — фото основателя и фото бренда |
| `event_poster_layouts` | макет афиши: строка на событие И ориентацию (`horizontal\|vertical\|square`), 63 поля настроек + `speaker_order` JSONB |

Формат точки — строка CSS `object-position` («50% 35%»). ⚠️ `NULL` = «не отмечено»
и означает НЕ центр, а верхнюю треть (`50% 33%`): центр — это ровно та резка,
что срезала головы. Проставить всем «50% 50%» нельзя — тогда не отличить
«клиент выбрал центр» от «клиент не трогал».

### Эндпоинты

| Метод | Путь | Что |
|---|---|---|
| `GET` | `/events/{id}/poster-layout/{orientation}` | макет + тема бренда + состав события одним запросом |
| `PUT` | `/events/{id}/poster-layout/{orientation}` | сохранить макет (UPSERT по `event_id`+`orientation`) |
| `GET` | `/events/{id}/poster-layout/{orientation}/png` | собрать и отдать картинку на скачивание |
| `POST` | `/events/{id}/poster-layout/{orientation}/render` | собрать и положить в афиши события (`event_posters`) |
| `GET` | `/public/poster/data` | данные для страницы отрисовки, по подписанному токену |

### Правила доступа

- **Фича `poster_generator`** (мигр. 436) — пока включена ТОЛЬКО в скрытом тарифе
  `admin`. Гейт по фиче, не по `client_id`: открыть всем = галочка в тарифе.
- Проверка стоит в **каждой** ручке (`_guard`), в публичной ручке данных и на
  фронте — включая прямой переход по `?sub=generator`.
- ⚠️ Токен предпросмотра знает только клиента, **не событие** — владение
  событием проверяется отдельно, иначе по своему токену вытащишь чужой состав.
- Помощнику с ограничениями запись и сборка закрыты (`assistant_is_restricted`).

### Отрисовка

Картинку снимает **headless Chrome** с той же вёрстки, что показывает
предпросмотр (`poster_render.py`), — не Pillow и не canvas: иначе предпросмотр
разошёлся бы с готовым файлом на переносах фамилий и кегле. Очередь печати
`_PRINT_LOCK` общая с PDF лендингов и обложками — по одной картинке за раз.

---

## Плюсоновский лид-магнит (миграция 472, 20.09.2026)

Подарок платформы в кабинете КАЖДОГО клиента: он раздаёт доступ к ПЛЮСОНу и
получает за пришедших реферальные начисления. Подробно — в
[BOTS-AND-MINIAPP.md](architecture/BOTS-AND-MINIAPP.md#плюсоновский-лид-магнит--подарок-платформы-у-каждого-клиента-миграция-472-от-2026-09-20).

### Изменения в БД

| Таблица | Колонка | Что |
|---|---|---|
| `lead_magnets` | `is_plusson BOOLEAN NOT NULL DEFAULT FALSE` | признак платформенного подарка; уникальный частичный индекс `lead_magnets_plusson_uidx ON (client_id) WHERE is_plusson` — ровно один на клиента |
| `platform_settings` | `plusson_lm_name TEXT` | название, одно на всю платформу |
| `platform_settings` | `plusson_lm_description TEXT` | описание |
| `platform_settings` | `plusson_lm_delivery TEXT NOT NULL DEFAULT 'direct'` | CHECK `('direct','funnel')` — куда ведёт прямая ссылка |
| `platform_settings` | `plusson_lm_visibility TEXT NOT NULL DEFAULT 'testing'` | CHECK `('testing','all')` — кому виден (мигр. 473): `testing` — только `admin`/`is_system_service` |
| `clients` | `referred_source TEXT` | чем привели: `plusson_lm` \| NULL (обычная реф-ссылка) |
| `contacts` | `plusson_referrer_source TEXT` | то же, но на контакте — до регистрации помнить метку больше негде |

Миграция раздаёт подарок всем существующим клиентам (163 на момент выката) —
slug генерируется тем же алфавитом и проверяется на уникальность И по
`lead_magnet_packages`.

### API

| Метод | Путь | Что |
|---|---|---|
| `GET` | `/admin/plusson-lead-magnet` | текст, режим и цифры (сколько экземпляров, переходов, регистраций, у скольких клиентов подарка нет) |
| `PATCH` | `/admin/plusson-lead-magnet` | сохранить; текст разносится по всем экземплярам в той же транзакции |

### Правила доступа

- Админские ручки — `get_current_admin`, как и вся `/admin/*`.
- `DELETE /lead-magnets/{id}` при `is_plusson` → **400**, а не удаление.
  Проверка запросом, а не скрытием кнопки: удаление приходит от браузера.
- `PATCH /lead-magnets/{id}` при `is_plusson` **не меняет** `name`,
  `description`, `url`, `link_source` — остальное клиент настраивает как обычно.
- Формат payload реф-ссылки: `ref<8симв>` либо `ref<8симв>-lm`. Разбор — только
  через `parse_plusson_ref_payload` / `parse_plusson_ref_source`
  ([plusson_referral.py](backend/app/services/plusson_referral.py)), своих
  регулярных выражений в ботах быть не должно: копия, не знающая про хвост,
  молча теряет реф-код целиком.
