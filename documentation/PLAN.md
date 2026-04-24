# ПЛАН РАЗРАБОТКИ ПЛЮСОН

> Когда задача выполнена — скажи Клоду, он обновит `[x]`.

---

## ⚠️ Ключевые архитектурные принципы (не нарушать!)

### Один человек = один реф-код навсегда
Человек как сущность в системе имеет **ровно один реф-код** — независимо от его роли: участник, спикер, коллаборатор, просто контакт в базе.

- Реф-код хранится в `platform_users.ref_code` — это единственный источник истины
- `conf_speaker_events.ref_code` = `platform_users.ref_code` для того же человека (НЕ генерировать отдельный спикерский код)
- При любом импорте, добавлении, обновлении — синхронизировать ref_code из platform_users
- Нарушение: два разных кода у одного человека → раздвоение статистики, потеря реферралов

---

## Что сейчас работает на сервере

- ✅ Сервер Beget VPS 194.156.119.17, домен https://pluson.margoforbs.ru, SSL
- ✅ База данных PostgreSQL — все таблицы созданы
- ✅ FastAPI бэкенд — авторизация, события, подарки, спикеры, сессии
- ✅ Next.js веб-кабинет — страницы клиента и администратора
- ✅ Mini App — задеплоен, зарегистрирован в BotFather
- ✅ Telegram Bot `@pluson_bot` — работает в polling-режиме
- ✅ Клиент: `margarita.vl2011@gmail.com` / `Playball8013!`
- ✅ Администратор: `admin@plusson.app` / `Mill20ion!Forbs`

---

## ЭТАП 1 — КОНФЕРЕНЦИЯ (СРОЧНО, делаем сейчас)

> Цель: первая живая конференция ivision-7 работает через ПЛЮСОН

### 1.1 Модуль конференции — веб-кабинет Клиента

**Создание и основные настройки конференции:**
- [ ] Страница создания конференции — название события, slug (автогенерация)
- [ ] Настройки конференции:
  - Даты проведения (начало / конец, кол-во дней вычисляется автоматически)
  - Главный оффер / подзаголовок (идёт на сайт)
  - Ссылка на лендинг регистрации (GetCourse и т.п.)
  - Ссылка на общий чат участников
  - Афиши конференции: загрузка файлов в 3 форматах (горизонтальный, вертикальный, квадратный) — каждого формата может быть несколько штук

**Спикеры / Хедлайнеры / Партнёры:**
- [ ] Список всех спикеров события с карточками
- [ ] Добавление участника (имя + фамилия / название компании), роль: спикер / хедлайнер / партнёр
- [ ] Страница настройки спикера:
  - Регалии (текстовое поле, можно заполнить позже)
  - Ссылка на Telegram-канал (можно позже)
  - Ссылка на папку с фото
  - Ссылка на папку с видео
  - Дополнительная информация (свободное текстовое поле)
  - Тема выступления (только для спикеров и хедлайнеров)
  - Подарок после выступления: название (многострочный текст) + ссылка на получение
  - Личный аккаунт спикера в системе (привязка к клиенту ПЛЮСОН, если есть)
  - Реферальная ссылка спикера (чтобы он мог приглашать участников и получать свою статистику)
  - Индивидуальная афиша спикера: загрузка в 2 форматах (вертикальный, квадратный)

**Программа конференции:**
- [ ] Настройка программы по дням:
  - Время открытия конференции в этот день
  - Время закрытия (финальный блок)
  - Ссылка на трансляцию для этого дня
- [ ] Генератор расписания:
  - Задать: длительность выступления (по умолчанию 30 мин), перерыв между выступлениями (по умолчанию 10 мин)
  - Кнопка «Сгенерировать» → автоматически расставить спикеров по тайм-слотам
  - Возможность переставить вручную (drag-and-drop или выбор времени)
- [ ] Экспорт программы в JSON

**Настройка сообщений бота:**
- [ ] Приветственное сообщение при регистрации (шаблон с переменными: имя, название конференции)
- [ ] Сообщение с напоминанием о старте (за 1 день, утром дня конференции)
- [ ] Автосообщения по программе (настраиваются в разделе «Рассылки», см. п. 1.3)

---

### 1.2 Mini App — что должен видеть участник

**Поток если участник НЕ зарегистрирован на конференцию:**
- [ ] Переход по ссылке (Smart Bridge) → бот отправляет приветственное сообщение + ссылку на регистрацию (GetCourse)
- [ ] Mini App открывает лендинг конференции встроенно

**Поток если участник зарегистрирован:**
- [ ] Mini App открывается — показывает поздравление с регистрацией и навигацию
- [ ] Подсказка: «Смотри программу во вкладке Программа» + «Хочешь подарки — пригласи друзей во вкладке Игра»

**Вкладка [Программа]:**
- [ ] Расписание по дням (переключение между днями)
- [ ] Каждый блок: время + имя спикера + фото + тема + кнопка «Смотреть» (ссылка на трансляцию дня)
- [ ] После выступления — появляется блок «Подарок от спикера» с кнопкой получения
- [ ] Открытие/закрытие дня как отдельные блоки

**Вкладка [Игра] — реферальная механика:**
- [ ] Прогресс: сколько человек пришло по твоей ссылке
- [ ] Подарки: список подарков с порогами (1 / 5 / 10 приглашённых), статус каждого
- [ ] Кнопка «Поделиться» — открывает Telegram share с реферальной ссылкой
- [ ] Материалы: афиши конференции для скачивания / репоста

---

### 1.3 Рассылки по программе (ОЧЕНЬ ВАЖНО)

**Автоматические рассылки по тайм-слотам (5 дефолтных шаблонов, автосоздаются при первом открытии страницы «Шаблоны»):**
- [x] `pre_start` — за 5 минут до начала выступления спикера. Фото — афиша спикера, кнопка «Войти в эфир» = `{stream_url}`
- [x] `gift` — за 10 минут до конца выступления. С fallback «пишите в личку» если нет подарка/ссылки
- [x] `day_start_30min` — за 2 часа до начала дня конференции (offset_minutes=120). Фото — горизонтальная афиша, поддержка `@forbs_service2` захардкожена в тексте
- [x] `day_live` — в момент старта дня, «Мы начинаем День N»
- [x] `day_end` — по окончании дня, благодарность + призыв ввести кодовые слова + автоматический список подарков всех спикеров дня через `{day_speakers_gifts}`
- [x] Все шаблоны редактируемые в веб-кабинете

**Настройка рассылок в веб-кабинете:**
- [x] Раздел «Рассылки» внутри страницы конференции, разделён на две подвкладки: «Шаблоны» (/broadcasts/templates) и «Очередь рассылок» (/broadcasts/queue)
- [x] Список всех запланированных рассылок (дата, время, тип, статус: pending/running/done/cancelled)
- [x] Редактирование текста каждого шаблона
- [x] Создание кастомных шаблонов: кнопка «Добавить шаблон» на странице «Шаблоны». Модалка задаёт название, день (За N дней до / День N / Через N дней после — собирается из conf_days), время, текст с плейсхолдерами, фото (URL с превью), кнопку и аудиторию. type='custom'. generate_schedules сам вычисляет fire_at из conf_days + custom_time. Поддерживаются плейсхолдеры {conf_title}, {conf_date}, {conf_description}, {day_number}, {day_date}, {day_program}, {stream_url}, {registration_url}, {raffle_url}, {first_name}. Миграция 028.
- [x] Произвольная рассылка в очереди — без шаблона: фото + текст (с `{first_name}`) + до 3 кнопок. Endpoint `/schedules/add-custom`. Миграция 029 (snapshot_buttons JSONB).
- [x] Пакетная загрузка рассылок — формат с разделителем `---`, валидация через `/schedules/bulk-add?dry_run=true`, итоговая запись транзакцией. Показываются ошибки по каждой задаче с номером.
- [x] Удаление одной задачи — иконка-корзина справа от каждой задачи (в т.ч. done/cancelled). Pending/running сначала отменяются, потом удаляются.
- [x] Сворачиваемые группы по дням в очереди — клик на шапку дня скрывает/раскрывает, состояние сохраняется в localStorage per-event.
- [x] Шаблон «Подарок спикера»: если в тексте заданы плейсхолдеры `{speaker_name}` / `{gift_title}` / `{gift_url}` / `{personal_tg}` — используется текст шаблона; иначе — дефолтный формат (раньше текст шаблона игнорировался).
- [ ] Кнопка «Одобрить» — без одобрения рассылка не уходит (защита от случайной рассылки)
- [ ] Статусы: `draft → approved → sending → sent` / `cancelled`

**Тестирование рассылок:**
- [ ] Кнопка «Отправить себе тест» — отправляет сообщение на Telegram-аккаунт клиента
- [ ] Поле «Тестовый Telegram ID» в настройках аккаунта

---

### 1.4 База данных и регистрация участников

**Сохранение участников:**
- [ ] Все кто зашёл в бот → сохраняются в `telegram_users`
- [ ] Привязка к событию → запись в `event_participants`
- [ ] Реферальная связь — **по событию** (не навсегда): если Маша привела Катю на конференцию — Маша получает баллы только за эту конференцию. На следующем событии всё начинается заново. Это стимулирует людей приглашать на каждое событие.

**GetCourse webhook:**
- [ ] При оплате/регистрации на GetCourse → вебхук → участник активируется в системе
- [ ] Подключить реальный ivision-7

---

## ЭТАП 2 — РЕФЕРАЛКА (после конференции)

> Цель: реферальная механика работает автономно, подарки начисляются автоматически

### 2.1 Настройка подарков (веб-кабинет)
- [ ] Список подарков с настройкой: название, описание, ссылка получения, порог (кол-во приглашённых)
- [ ] Порог может быть любой: 1 / 5 / 10 / 20 — клиент настраивает сам
- [ ] Статус подарка: активен / неактивен

### 2.2 Начисление подарков
- [ ] Автоматически при достижении порога: бот отправляет сообщение с подарком
- [ ] Защита от двойного начисления (атомарная транзакция)

### 2.3 Управление участниками (веб-кабинет)
- [ ] Таблица всех участников события: имя, Telegram, дата входа, дата регистрации, кто пригласил, кол-во приглашённых, полученные подарки
- [ ] Поиск и фильтрация
- [ ] Экспорт в CSV

---

## ЭТАП 3 — ПЛАТФОРМА (после рефералки)

> Цель: другие клиенты могут самостоятельно зарегистрироваться и создать своё событие

- [ ] Страница регистрации нового клиента работает полностью (email-верификация)
- [ ] Тарифы и paywall (ЮKassa / Stripe)
- [ ] Партнёрская программа — коды партнёров, статистика привлечённых клиентов
- [ ] Панель администратора — полное управление платформой

---

## Открытые архитектурные вопросы

- [ ] Реферальная ссылка спикера: спикер — это особый участник или отдельная роль? (Предложение: спикер = участник с флагом `is_speaker`, получает персональный ref_code для отслеживания своих приглашений)
- [ ] Конкретные цены тарифов (Базовый / Профессиональный)
- [ ] Платёжная система (ЮKassa или Stripe)

---

## Технические задачи (фон)

- [ ] Подключить Celery для отложенных рассылок (Redis уже установлен на VPS)
- [ ] Настроить cron для автозапуска рассылок по расписанию
- [ ] Подключить реальные данные события в `/l/[slug]` из PostgreSQL (сейчас заглушка)
- [ ] Документация по деплою обновлений на VPS (git pull + restart)

---

## ЭТАП 4 — РЕФАКТОРИНГ БД (после конференции)

> Цель: поддержка нескольких ботов, мультиплатформенность, правильная иерархия Контактов

### Концепция

Сейчас один бот (`clients.bot_token`) на всё. После конференции нужно поддержать несколько ботов у одного Клиента (`@pluson_bot`, `@margo_forbs_bot`) и в перспективе другие платформы (VK, Max).

Терминология которую нужно соблюдать везде:
- **Клиенты** → таблица `clients` (пользователи платформы ПЛЮСОН)
- **Контакты** → таблица `platform_users` (все люди в базе Клиента)
- **Коллабораторы** → таблица `collaborators` (подмножество Контактов: спикеры, партнёры)
- **Спикеры** → таблица `conf_speaker_events` (роль Коллаборатора в конкретном событии)
- **Участники** → таблица `event_participants` (Контакты зарегистрированные в событии)

### Иерархия сущностей

```
Контакты (platform_users)
    ├── Коллабораторы (collaborators) ← подмножество Контактов
    │       └── Спикеры (conf_speaker_events) ← роль Коллаборатора в конкретном событии
    └── Участники (event_participants) ← Контакты зарегистрированные в событии
```

### Целевая структура таблиц

**`clients` — Клиенты ПЛЮСОН**
```
clients
├── id, email, name, phone, telegram_username
├── password_hash
├── tariff_slug → tariffs
├── partner_code → partners
├── test_telegram_ids TEXT[]
├── trial_ends_at, is_active
└── ❌ bot_token — УБРАТЬ, переезжает в channels
```

**`channels` — каналы доставки (боты, группы VK, каналы Max)**
```
channels
├── id
├── client_id → clients
├── platform ('telegram' | 'vk' | 'max')  ← тип платформы живёт ЗДЕСЬ, не в platform_users
├── display_name
├── handle  ← @username бота или id группы
├── bot_token  ← переехал из clients.bot_token
└── is_active
```

**`platform_users` — Контакты**
```
platform_users
├── id
├── client_id → clients
├── platform_user_id  ← tg_id / vk_id (TEXT)
├── username, first_name, last_name
├── email, phone, tags JSONB, utm_source
├── salebot_id, platform_meta JSONB
├── referrer_tg_id TEXT                 ← кто привёл (tg_id реферера, текущее поле)
├── referrer_ref_code VARCHAR(100)      ← реф-код реферера (текущее поле)
├── first_referrer_id → platform_users  ← НОВ: кто впервые привёл (только аналитика)
├── first_referred_at                   ← НОВ: когда впервые привёл
├── last_contact_at
├── UNIQUE(client_id, platform_user_id)
└── ❌ platform — УБРАТЬ, переехал в channels.platform
└── ❌ is_unsubscribed — УБРАТЬ, переехал в platform_user_channels
└── ❌ ref_code — УБРАТЬ, ref_code живёт в event_participants (Участники) и conf_speaker_events (Спикеры)
```

**`platform_user_channels` — кто в каком боте подписан**
```
platform_user_channels
├── id
├── platform_user_id → platform_users
├── channel_id → channels
├── is_unsubscribed  ← переехал из platform_users, теперь per-канал
├── subscribed_at
└── unsubscribed_at
```

**`collaborators` — Коллабораторы**
```
collaborators
├── id
├── platform_user_id → platform_users  ← НОВ: Коллаборатор является Контактом
├── created_by_client_id → clients
├── name, title, achievements TEXT[]
├── photo_url, photo_folder_url, video_folder_url
├── tg_channel_url, tg_channel_id
├── personal_tg_id, personal_tg_username
├── assistant_tg_username
└── instagram_url, website_url
```

**`conf_speaker_events` — Спикер = Коллаборатор в конкретной конференции**
```
conf_speaker_events
├── id
├── speaker_id → collaborators
├── event_id → events
├── role ('speaker'|'headliner'|'partner'|'organizer'|'commercial'|'general_partner')
├── gift_after_speech_title, gift_after_speech_url
├── gift_raffle_title, gift_raffle_url
├── poster_url, partner_url, extra_info
├── ref_code UNIQUE
├── referrer_ref_code TEXT  ← кто привёл спикера (реф-код реферера)
├── bot_in_channel BOOLEAN
├── is_visible, sort_order
└── UNIQUE(speaker_id, event_id)
```

**`event_participants` — Участники конкретного события**
```
event_participants
├── id
├── event_id → events
├── platform_user_id → platform_users
├── referrer_participant_id → event_participants  ← кто пригласил (per-событие, не помним между событиями)
├── referrer_ref_code TEXT  ← реф-код рефовода (ищем в event_participants или conf_speaker_events)
├── ref_code TEXT UNIQUE
├── status ('interested' | 'registered' | 'in_chat')
└── UNIQUE(event_id, platform_user_id)
```

**`broadcast_templates` — шаблоны рассылок**
```
broadcast_templates
├── id, client_id → clients, event_id → events
├── name, type ('pre_conf'|'speaker_intro'|...|'custom'), text, photo_url, button_text, button_url
├── schedule_mode, offset_minutes
├── audience_include, audience_exclude
├── intro_start_time, intro_interval_min, intro_days_before  ← для speaker_intro
├── custom_day_ref ('before_N'|'day_N'|'after_N'), custom_time ('HH:MM')  ← для type='custom'
├── channel_ids INT[]  ← НОВ: массив id каналов через которые слать
└── allow_custom_datetime
```

**`broadcast_schedules` — очередь рассылок**
```
broadcast_schedules
├── id, event_id → events
├── session_id → conf_sessions, template_id → broadcast_templates
├── type, fire_at, status ('draft'|'pending'|'running'|'done'|'cancelled')
├── is_test, test_recipients JSONB
├── audience_include, audience_exclude
├── channel_ids INT[]  ← НОВ: массив id каналов через которые слать
└── recipients_sent, error_log, started_at, finished_at
```

**`broadcast_log` — лог каждого отправленного сообщения**
```
broadcast_log
├── id
├── schedule_id → broadcast_schedules
├── platform_user_id → platform_users
└── status ('sent'|'failed'|'skipped'), error, sent_at
```

**`events` — события**
```
events
├── id, client_id → clients
├── slug UNIQUE, title, description
├── module_slug → modules  ← тип события (conference | webinar | award | tournament | base)
├── poster_url, landing_url, webhook_url
├── points_free, points_paid, points_scope
├── require_subscription, status ('draft'|'active'|'ended')
└── created_at
```

**`event_subscriptions` — требования подписки на каналы**
```
event_subscriptions
├── event_id → events
├── platform, channel_id, channel_title
└── is_required
```

**`gifts` — подарки события**
```
gifts
├── id, event_id → events
├── title, description, points_cost, link_url
└── stock, sort_order
```

**`gift_issuances` — выдача подарков**
```
gift_issuances
├── gift_id → gifts
├── participant_id → event_participants
└── status ('pending'|'issued')
```

**`materials` — материалы события**
```
materials
├── id, event_id → events
├── gift_id → gifts
├── title, description, link_url
└── type ('free'|'paid'), is_eternal, status, sort_order
```

**`promo_materials` — афиши и тексты анонсов**
```
promo_materials
├── id, event_id → events
└── type ('poster'|'text'|'link'), title, content, file_url
```

**`referral_events` — клики и конверсии**
```
referral_events
├── id, event_id → events
├── ref_code, visitor_tg_id
├── type ('click'|'free'|'paid')
└── points_awarded, level
```

**`conf_conferences` — конференция**
```
conf_conferences
├── id, event_id → events (UNIQUE)
├── subtitle, description, start_date, end_date, timezone
├── subscription_mode ('none'|'organizer'|'all_speakers')
├── organizer_speaker_id → collaborators
├── is_live, require_speakers_sub
├── vip_upsell_url, landing_url, getcourse_form_url
├── chat_url, stream_url_day_1, stream_url_day_2
└── test_telegram_ids TEXT[]
```

**`conf_sessions` — слоты программы**
```
conf_sessions
├── id, event_id → events
├── speaker_id → conf_speaker_events
├── topic_id → conf_speaker_topics
├── day, start_datetime, title
└── gift_description, track_label, track_color, sort_order
```

**`conf_speaker_topics` — темы выступления**
```
conf_speaker_topics
├── id, cse_id → conf_speaker_events
└── topic, sort_order
```

**`conf_secret_codes` — кодовые слова**
```
conf_secret_codes
├── id, event_id → events
├── speaker_id → conf_speaker_events
└── code_word, tickets_reward
```

**`conf_promo_partners` — промо-партнёры конференции**
```
conf_promo_partners
├── id, event_id → events
├── name, telegram_url, partner_code
└── UNIQUE(event_id, partner_code)
```

**`conf_commercial_items` — коммерческие услуги**
```
conf_commercial_items
├── id, event_id → events
└── type, title, description, is_paid, action_url, sort_order
```

**`conf_raffle_tickets` — билеты розыгрыша**
```
conf_raffle_tickets
├── id, event_id → events
├── pluson_participant_id → event_participants
├── ticket_number, tg_username, tg_id, tg_name
└── salebot_client_id, code_word
```

**`conf_reports` — отчёты конференции**
```
conf_reports
├── id, event_id → events, created_at
├── announcements (вводится вручную)
├── total_entered, total_registered
├── speakers_entered, speakers_registered
├── referrals_entered, referrals_registered
├── speakers_data JSONB  ← [{speaker_event_id, name, tg_id, entered, registered}]
└── referrals_data JSONB ← [{platform_user_id, name, username, tg_id, entered, registered}]
```

**Служебные таблицы (не меняются)**
```
tariffs — тарифы платформы
modules — модули (conference, base, ...)
partners — партнёры-реселлеры ПЛЮСОН
admins — администраторы платформы
client_modules — подключённые модули клиента
referral_levels — многоуровневые баллы (заложено, не MVP)
```

### ⚠️ Нерешённые вопросы по рассылкам

**1. Аудитория — кому слать**
Сейчас в `broadcast_templates` и `broadcast_schedules` есть `audience_include` / `audience_exclude` — это отвечает на вопрос «кто». Значения: `all_event`, `all_client`, `registered_event` и т.д. Это остаётся.

**2. Каналы — через какой бот слать**
Сейчас одно поле `channel_id → channels` — это значит рассылка идёт через один конкретный бот. Но если рассылка «всей базе» — человек может быть в двух ботах, и надо слать в оба.

Варианты которые надо выбрать:
- `channel_id = NULL` → слать через ВСЕ каналы где Контакт подписан и не отписался
- `channel_id = конкретный` → слать только через этот бот
- Или отдельное поле `send_to_all_channels BOOLEAN`

**3. Дедупликация при рассылке по всем ботам**
Если Вася в двух ботах и рассылка идёт по всем — он получит два одинаковых сообщения. Нужно решить: это нормально или нужна дедупликация (слать только через один, например первый подключённый)?

**Решено:**
- `channel_ids INT[]` — массив id каналов в шаблоне и расписании. Всегда указываем явно какие боты
- Массив не может быть пустым — рассылка без канала запрещена, валидация на уровне API
- Если Контакт в двух ботах и оба в массиве — получит два сообщения, это нормально
- Дедупликации нет — разные боты, разный контекст

### Логика отписки

- Один Контакт в двух ботах → две записи в `platform_user_channels`
- Отписался от `@margo_forbs_bot` → `is_unsubscribed = true` только для этой записи
- Рассылка через канал → берём только `is_unsubscribed = false` для этого `channel_id`

### Логика рефовода

- Рефовод per-событие: каждое событие с чистого листа, `referrer_participant_id` контекстный
- `first_referrer_id` — только аналитика, никогда не меняется, наград не даёт

### Что сломается при переезде (9 файлов)

`clients.bot_token` используется в:
- `app/tasks/broadcast.py` — рассылки (критично)
- `app/services/message_builder.py`, `notification_service.py` — отправка
- `app/api/modules/broadcasts.py`, `conference.py` — API
- `app/api/subscription_check.py`, `event.py`, `auth.py`
- `bot/main.py` — сам бот

`platform_users.is_unsubscribed` используется в:
- `app/tasks/broadcast.py`
- `app/api/contacts.py`

**Стратегия переезда:** сначала создать новые таблицы, перенести данные, затем переписать код файл за файлом, в конце удалить старые поля.
