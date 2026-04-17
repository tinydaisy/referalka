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

- Всегда отвечать на **русском языке**
- Это **no-code / AI-driven разработка** — весь код пишет Claude, пользователь не программист
- Перед началом новой задачи читать `documentation/PLAN.md` чтобы понимать текущий статус
- После значимых архитектурных решений обновлять `PROJECT_DOCUMENTATION.md` и `documentation/PLAN.md`
- Объяснять технические решения простым языком
- Не усложнять — MVP строится минимальными средствами, достаточными для работы

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
- **Production only** — всегда запускать всё в production на Beget VPS (194.156.119.17), не в dev-режиме. Это единственная истина о том, как работает сервис
- **Тестирование после каждого запроса** — после каждого изменения (фича, баг-фикс, улучшение) обязательно протестировать как реальный пользователь через https://pluson.margoforbs.ru/ и Telegram Mini App (@pluson_bot). Описать результаты в ответе

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

### PLUSSON — одна платформа, не два продукта
- **ivision-conf — не отдельный продукт.** Это аккаунт Марго в PLUSSON с модулем «Конференция»
- **Репо `ivision-conf`** хранит только статичный лендинг текущей конференции. Весь TMA, бэкенд, бот и redirect_web_app — здесь, в `referalka`
- **Модульная архитектура:** ядро ([Игра]) всегда, дополнительные вкладки — через модули. Модули: `conference`, `webinar`, `training`, `promo`

### Smart Bridge — редирект с лендинга в Telegram Mini App
- Лендинги событий: `/l/{event_slug}` (Next.js динамический маршрут, данные из БД)
- Каждый лендинг включает `redirect_web_app.js`: если `?app=tg` → редирект в Telegram с параметрами
- Формат startapp: `ref_pg{event_slug}[_pid{partner_id}][_src{utm_source}]`
- Mini App (App.tsx): при открытии вызывает `requestWriteAccess` (разрешение боту писать), отправляет `event_start` на бэкенд, бот шлёт приветствие
- Веб-ссылка: `https://plusson.app/l/ivision-7`
- Ссылка в Telegram: `https://plusson.app/l/ivision-7?app=tg`
- С партнёром и UTM: `https://plusson.app/l/ivision-7?app=tg&new_partner_id=123&utm_source=insta`

### Структура БД
- **Many-to-Many для участников:** `telegram_users` (личные данные) + `event_participants` (факт участия)
- Один человек в 3 событиях = 1 запись в `telegram_users` + 3 записи в `event_participants`
- `referrer_participant_id` ссылается на `event_participants` — реферальная связь контекстная, только внутри события
- **Модульные таблицы** с префиксом `conf_` принадлежат модулю «Конференция»
- **⚠️ Спикеры — per-client, не per-event:** таблица `speakers` (client_id) + `conf_speaker_events` (speaker_id + event_id). `conf_speakers` — устаревшая схема, подлежит замене миграцией 003_speakers_refactor.sql

### Архитектура дашборда (зафиксировано 2026-04-17)

**Дашборд = набор модулей.** Рефералка — не тип события, а механика поверх любого события.

**Роутинг веб-кабинета:**
- `/dashboard` — главная: плитки модулей (Рефералки, Конференции, Премии, Турниры)
- `/dashboard/referrals` — список реферальных кампаний
- `/dashboard/referrals/[id]` — кампания (метрики, ссылка, подарки, аналитика)
- `/dashboard/conferences` — список конференций
- `/dashboard/conferences/[id]` — конференция (основное, спикеры, программа, рассылки, промо)
- `/dashboard/speakers` — база спикеров клиента (глобальная)

**Сайдбар-секции:** РЕФЕРАЛКИ (Мои кампании) → КОНФЕРЕНЦИИ (Мои конференции, Мои спикеры) → Премии/Турниры (скоро)

**Создание реф. кампании** — два пути: 1) новое событие, 2) привязать к существующему событию (конференция и т.д.)

### Продуктовые решения
- **Один общий бот и один Mini App для всех Клиентов** — кастомные боты не предусмотрены (в MVP)
- **Mini App = приложение сервиса**, Клиент брендирует своё событие через афишу и название
- **Нет white label, нет кастомного домена** — Участник не взаимодействует с веб-версией
- **MVP без paywall** — все Клиенты на «beta»-тарифе, все модули открыты. Платёжка — в Этапе 2
- **Партнёрская программа в MVP** — таблица `partners`, поле `clients.partner_code`, раздел «Партнёры» в Admin-панели
- **Промо-партнёры события** — таблица `conf_promo_partners`, поле `promo_partner_code` в `event_participants`

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
