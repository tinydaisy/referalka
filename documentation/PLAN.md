# ПЛАН РАЗРАБОТКИ ПЛЮСОН

> Когда задача выполнена — скажи Клоду, он обновит `[x]`.

---

## ⚠️ Ключевые архитектурные принципы (не нарушать!)

### Иерархия Контактов — пять связанных таблиц (миграция 036 от 26.04.2026)

```
platforms (telegram/vk/max справочник)
   ↑
contacts (ЧЕЛОВЕК) ← ref_code, email, phone, имя
   ↓
platform_users (его аккаунт на платформе) ← username, tg_id/vk_id
   ↓
platform_user_channels (подписка аккаунта на канал клиента)
   ↑
channels (боты/группы клиента)
```

- Один человек = одна запись в `contacts`. Если у него TG и VK — две `platform_users`, ссылающиеся на тот же `contact_id`.
- Реф-код, email, phone, теги — на уровне человека (`contacts`), а не аккаунта.
- Username, tg_id — на уровне аккаунта (`platform_users`).
- Один аккаунт может быть в нескольких каналах клиента (например, в двух его TG-ботах) — каждая подписка отдельной строкой в `platform_user_channels`.
- Платформа — справочник `platforms` (нельзя ввести опечатку). У платформы метаданные: иконка, цвет, лимит сообщения.
- Автомердж при импорте: ищем существующий contact по email/phone, привязываем новую идентичность. Не нашли — создаём. Дубли — через ручной мердж в UI.

### Один реф-код на человека (миграция 032 от 26.04.2026, переехал в contacts миграцией 036)
- Источник истины — `contacts.ref_code` UNIQUE
- Поля `event_participants.ref_code` и `conf_speaker_events.ref_code` УДАЛЕНЫ (миграция 032)
- Резолв реферера всегда через `JOIN contacts WHERE c.ref_code = referrer_ref_code`
- Резолв спикера: `c.ref_code → collaborators.contact_id → conf_speaker_events`
- В `contacts.first_referrer_contact_id` — кто впервые привёл (вместо `first_referrer_ref_code`)
- В `event_participants.referrer_ref_code` остаётся per-event реферер
- Слитые реф-коды — в `contacts.merged_ref_codes` JSONB

### Мультиплатформа — каналы доставки (миграции 033+034+036)
- `bot_token` живёт в `channels` (per-канал), у клиента может быть несколько ботов
- Подписка/отписка — в `platform_user_channels` per-канал, не на самом контакте
- `clients.bot_token` УДАЛЕНО (033), `platform_users.is_unsubscribed` УДАЛЕНО (034)
- `platform_users.platform` возвращена как `platform_slug` → `platforms(slug)` (036)
- Составные FK гарантируют совпадение платформ: TG-аккаунт нельзя подписать на VK-группу

### Реф-программа — вкладка события, не отдельный раздел (миграция 035 от 26.04.2026)
- Раздел «Рефералки» из сайдбара убран
- Реф-программа — вкладка внутри карточки **любого события** (мероприятия и конференции)
- Подвкладки: Подарки (пороги → лид-магнит) / Материалы (картинки для шеринга) / Шаблоны (welcome + share text)
- Лид-магниты — общая база per-client (`lead_magnets`), используются как подарки в реф-программе любого события

---

## История ключевых миграций БД (актуальное состояние)

| # | Дата | Что |
|---|---|---|
| 023 | до 2026-04-25 | `platform_users.referrer_tg_id`, `referrer_ref_code` (миграция импорта Salebot) |
| 024-031 | до 2026-04-25 | broadcast snapshot, спикерские флаги, work_account, custom-шаблоны рассылок |
| **032** | 2026-04-26 | **Единый ref_code в `platform_users`**: удалены `event_participants.ref_code` и `conf_speaker_events.ref_code`; `platform_users.referrer_ref_code` → `first_referrer_ref_code`; удалён `platform_users.referrer_tg_id`; добавлен FK `collaborators.platform_user_id → platform_users(id)` |
| **033** | 2026-04-26 | **Мультиплатформа — каналы доставки**: новые таблицы `channels` и `platform_user_channels`; данные перенесены из `clients.bot_token` и `platform_users.is_unsubscribed` |
| **034** | 2026-04-26 | **Удаление унаследованных полей**: `clients.bot_token`, `platform_users.platform`, `platform_users.is_unsubscribed`. UNIQUE на `platform_users` сменён на `(client_id, platform_user_id)` |
| **035** | 2026-04-26 | **Лид-магниты + реф-программа как вкладка**: `lead_magnets`, `event_posters`, `event_referral_settings`, `event_referral_thresholds`, `event_referral_materials`. Расширение `events`: `address`, `start_at`, `end_at` |
| **036** | 2026-04-26 | **Иерархия Контактов**: справочник `platforms` (telegram/vk/max + метаданные); таблица `contacts` (человек, ref_code, email, phone, first_referrer_contact_id, merged_into); `platform_users` теперь идентичность с `contact_id` + `platform_slug` FK; `event_participants` и `collaborators` переключены на `contact_id`. Автомердж по email/phone + ручной мердж |
| **037** | 2026-04-26 | **Файловое хранилище R2**: `clients.storage_quota_bytes`, `storage_used_bytes`; таблица `client_files` для учёта загруженных файлов |
| **039** | 2026-04-27 | **Профиль клиента (Экосистема)**: `clients.bio`, `profile_photo_url`, `positioning`, `achievements` (JSONB), `social_links` (JSONB); таблица `client_offerings`; `events.successor_event_id` |
| **041** | 2026-04-27 | `conf_speaker_events.notes` — заметки спикера в конкретной конференции |
| **042** | 2026-04-27 | **Бренд клиента + VIP/Чат конференции + Призы розыгрыша**: `clients.brand_name`; `events.has_vip_tariff/vip_price/vip_url/vip_title/vip_description/chat_url/chat_subscriptions_required/chat_member_count_label`; `event_referral_settings.gift_count_mode` ('registered' default \| 'visited'); новые таблицы `event_raffle_settings`, `event_raffle_prizes`, `event_raffle_keywords`; UNIQUE индекс `channels(client_id, platform_slug) WHERE is_active` |

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

### 1.2 Mini App — двухуровневая архитектура (зафиксировано 2026-04-27)

> Подробное описание архитектуры — в `CLAUDE.md` раздел «Архитектура Mini App». Здесь — задачи к реализации.

**Принцип:** Хаб организатора (общая визитка) + Экран события (конкретное мероприятие).

#### 1.2.А Хаб организатора

- [ ] Контекст: открывается при `/start` без `startapp` или при тапе «‹ Назад» из события
- [ ] Шапка: фото клиента + имя + одна строка позиционирования
- [ ] Нижние вкладки (2): `📅 Календарь` · `🌐 Экосистема`
- [ ] Вкладка `Календарь`:
  - [ ] Секция «🔴 Сейчас идёт» (события клиента, у которых `start_at <= NOW() <= end_at`)
  - [ ] Секция «📅 Скоро» (`start_at > NOW()`, отсортировано по дате)
  - [ ] Секция «✓ Прошли» (`end_at < NOW()`, последние сверху)
  - [ ] Карточка события: афиша + название + дата + статус. Тап → Экран события
- [ ] Вкладка `Экосистема`:
  - [ ] Шапка: фото, имя, позиционирование, регалии (3 карточки), соцсети
  - [ ] Блок «Платно» — продукты клиента (`client_offerings.is_paid = true`) — карточки с CTA
  - [ ] Блок «Бесплатно» — материалы и открытые сообщества (`client_offerings.is_paid = false`)

#### 1.2.Б Экран события — три состояния

**А. ДО регистрации (`event_participants.is_registered = false` или нет записи):**
- [ ] Контент = только лендинг события: афиша + дата + описание + кнопка «Хочу участвовать»
- [ ] Нижние вкладки (5): `📋 Лендинг (открыта)`, `🔒 Программа`, `🔒 Игра`, `🔒 Розыгрыш`, `🔒 Услуги`
- [ ] Тап по 🔒 — попап «Зарегистрируйтесь чтобы открыть»
- [ ] **Замки только в нижней панели, НЕ в контенте**

**Б. ПОСЛЕ регистрации (событие активно):**
- [ ] Шапка: название · дата (через сколько / идёт сейчас)
- [ ] Нижние вкладки (4): `📅 Программа` · `🎯 Игра` · `🎟 Розыгрыш` · `💼 Услуги`
- [ ] **Без вкладок «Лендинг» и «Главное»** — Программа открывается по умолчанию
- [ ] Вкладка `Программа`:
  - [ ] Кнопка «📺 Подключиться к стриму» — только когда событие идёт сейчас
  - [ ] Расписание по дням, переключение между днями
  - [ ] Каждый блок: время · имя спикера · фото · тема · кнопка «Смотреть»
  - [ ] **Без афиши, без описания, без статуса** — это уже было на лендинге
  - [ ] Стрим (`stream_url`) виден **только зарегистрированным**
- [ ] Вкладка `Игра`:
  - [ ] Прогресс: сколько привёл из `event_participants` где `referrer_participant_id = текущий`
  - [ ] Пороги-подарки из `event_referral_thresholds` со статусом каждого
  - [ ] Реф-ссылка участника + кнопка «📤 Поделиться»
  - [ ] Материалы для шеринга из `event_referral_materials`
- [ ] Вкладка `Розыгрыш` — только если включён модуль (`conf_secret_codes` есть)
- [ ] Вкладка `Услуги` — `conf_commercial_items` per-event

**В. ПОСЛЕ завершения (`end_at < NOW()` или `events.status = 'ended'`):**
- [ ] Нижние вкладки (4) — комбинация события и хаба:
  1. `📋 Итоги` — спасибо + статистика участника + блок «А дальше: следующее событие» (`events.successor_event_id`)
  2. `🎯 Игра` — финальная статистика рефералки этого события
  3. `📅 Календарь` (от хаба) — события клиента
  4. `🌐 Экосистема` (от хаба) — визитка + продукты

#### 1.2.В Поток регистрации (между состоянием А и Б)

- [ ] Шаг 1 — Лендинг → тап «Хочу участвовать»
- [ ] Шаг 2 — **Форма контактов**:
  - Имя — prefilled из TG `initDataUnsafe.user.first_name + last_name`
  - Email — обязательно
  - Телефон — TG `requestContact` (запрос разрешения) или ручной ввод
- [ ] Шаг 3 — **Чек-лист подписок** (если `events.subscription_required = true`):
  - Список каналов из `event_subscriptions` (с привязкой к `channels`)
  - Кнопка «Проверить» → backend вызывает TG `getChatMember` для каждого канала
  - Не подписан → подсветка красным
- [ ] Шаг 4 — Создаём `event_participants` с `is_registered = true`, обновляем `contacts.email/phone` (через автомердж по миграции 036), переходим на состояние Б

#### 1.2.Г Связь между событиями

- [ ] Поле `events.successor_event_id` — какое событие предлагать после завершения текущего
- [ ] На состоянии В блок «А дальше» автоматически берёт это событие
- [ ] В дашборде клиента в карточке события — селектор «Следующее событие» (выбор из других событий клиента)

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
- [x] Cancel работает для running задач (помечает finished_at; дальнейшая отправка останавливается на следующем тике Celery, уже отправленные не отзываются).
- [x] Custom/Bulk создаются сразу со статусом pending (не draft) — Celery подхватывает их по расписанию без явного «Запустить очередь».
- [x] В модалке лога показывается статистика по причинам недоставки (бот заблокирован / чат не найден / flood / ...) с человекочитаемыми текстами через `humanReason()`.

**Общие рассылки (без события):** `/dashboard/broadcasts`
- [x] Миграция 030: `event_id` nullable, добавлен `client_id`. Для рассылок без события `event_id IS NULL`, `client_id` указывает на владельца.
- [x] Новый роутер `/api/v1/broadcasts/*` (add-custom, bulk-add, list, preview, log, cancel, delete, copy, fire-at) — client-scope, без event_id.
- [x] Страница `/dashboard/broadcasts` — произвольная и пакетная рассылки по всей базе клиента, без шаблонов и без «сформировать из программы». Аудитория зафиксирована на `all_client`.
- [x] Sidebar: пункт «Рассылки» под «Контакты» в секции БАЗА.
- [x] Celery поддерживает `event_id IS NULL` через LEFT JOIN events; chat-копирование не запускается (нет `conf_conferences`).

**Скорость рассылки (настраиваемая на клиенте):**
- [x] Миграция 031: `clients.broadcast_concurrency` (1..100, default 30)
- [x] В `/dashboard/settings` появился блок «Скорость рассылки» с вводом числа и подсказкой про 10/30/50+
- [x] Celery читает значение из клиента и применяет в `Semaphore`. `httpx max_connections` адаптируется (concurrency + 20, минимум 50). На 50+ потоках Telegram массово ловит 429 — сейчас есть авторетрай 1 раз с `retry_after`.
- [x] `auth.me` / `auth.update_me` возвращают и принимают `broadcast_concurrency`.

**Валидация HTML в рассылках:**
- [x] Клиентский валидатор `web/src/lib/validateTelegramHtml.ts` — проверяет открытые/закрытые теги, разрешённые имена (b, i, u, s, code, pre, a href, tg-spoiler, blockquote, span, br) и наличие `href` у `<a>`.
- [x] Бэкенд-зеркало `validate_telegram_html()` в `broadcasts_general.py` — защита от прямых API-вызовов в обход UI.
- [x] В модалках «Произвольное» и «Пакетом» (и в конфе, и в общих рассылках) ошибки HTML показываются под textarea, кнопка отправки блокируется до исправления.

**TODO — будущее: WYSIWYG-редактор для рассылок:**
- [ ] Сейчас текст вводится в textarea и редактируется как HTML — клиент должен сам набивать `<b>`, `<i>` и т.п. Это удобно для тех кто понимает HTML, но не для всех.
- [ ] Сделать переключатель режимов в одном поле:
  - **Визуальный режим** — выделил текст → кнопки B / I / U / S / ссылка / спойлер. Под капотом — HTML, но клиент его не видит.
  - **HTML режим** — как сейчас, для тех кто знает теги.
- [ ] Для визуального режима подойдёт лёгкая либа без зависимостей (например, [tiptap](https://tiptap.dev/) с минимумом расширений) или собственная реализация на `contenteditable` (с whitelist тегов под Telegram).
- [ ] Должен сохранять `{first_name}` плейсхолдер при переключении режимов.
- [ ] Применить к шаблонам рассылок (`/broadcasts/templates`), произвольным рассылкам (`/broadcasts` и в конфе), и в идеале — к описаниям спикеров/событий где тоже есть HTML.
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

## ЭТАП 2 — ЛИД-МАГНИТЫ + МЕРОПРИЯТИЯ + РЕФ-ПРОГРАММА (✅ задеплоено 26.04.2026)

> Цель: реф-механика как вкладка любого события, общая база лид-магнитов клиента, новый раздел «Мероприятия» (вебинары, уроки в записи, нетворкинги, эфиры).

> Архитектура зафиксирована 2026-04-25 в CLAUDE.md разделе «Архитектура дашборда».
> Реализация — 26.04.2026: миграция 035 + бэк (`backend/app/api/lead_magnets.py`, `referral_program.py`) + UI (страницы и вкладки).

### 2.1 Лид-магниты — общая база клиента ✅
- [x] Миграция 035: `lead_magnets`
- [x] Backend API: CRUD `/api/v1/lead-magnets`
- [x] Страница `/dashboard/lead-magnets`
- [x] Сайдбар: пункт «Лид-магниты» в секции «БАЗА»

### 2.2 Сайдбар: новая структура ✅
- [x] Раздел «РЕФЕРАЛКИ» убран из сайдбара
- [x] Раздел «СОБЫТИЯ» добавлен с пунктами «Мероприятия» и «Конференции»
- [x] Под «Настройками» — пункт «Тех.поддержка» (открывает @margo_forbs в Telegram)

### 2.3 Мероприятия — карточка события (вкладка «Основное») ✅
- [x] Миграция 035: `events.address`, `start_at`, `end_at`
- [x] Страница `/dashboard/events` (список с переключателем список/плитки, по умолчанию список)
- [x] Карточка `/dashboard/events/[id]` — вкладки: Основное · Афиши · Реф-программа · Рассылки
- [x] Поля в «Основное»: title, description, start_at, end_at, address, landing_url + метрики

### 2.4 Афиши события ✅
- [x] Миграция 035: `event_posters`
- [x] Backend API: CRUD `/api/v1/events/{id}/posters`
- [x] UI: вкладка «Афиши» — добавление по URL, выбор ориентации, удаление

### 2.5 Реф-программа — вкладка «Подарки» ✅
- [x] Миграция 035: `event_referral_thresholds`
- [x] Backend API: CRUD `/api/v1/events/{id}/referral/thresholds`
- [x] UI: подвкладка «Подарки» — пороги, выбор лид-магнита из общей базы, сертификат, текст выдачи
- [ ] Бот: при достижении порога — отправка `gift_template_text` участнику (логика в боте — отдельная задача)

### 2.6 Реф-программа — вкладка «Материалы» ✅
- [x] Миграция 035: `event_referral_materials`
- [x] Backend API: CRUD `/api/v1/events/{id}/referral/materials`
- [x] UI: подвкладка «Материалы» — выбор из афиш события или загрузка URL

### 2.7 Реф-программа — вкладка «Шаблоны» ✅
- [x] Миграция 035: `event_referral_settings` (welcome_text, share_text)
- [x] Backend API: GET/PUT `/api/v1/events/{id}/referral/settings`
- [x] UI: подвкладка «Шаблоны» — приветствие + текст-анонс

### 2.8 Реф-программа в конференциях ✅
- [x] Та же вкладка «Реф-программа» добавлена и в карточку конференций (общий компонент `ReferralProgramTab`)

### 2.9 Копирование событий и импорт реф-программы ✅
- [x] Backend `POST /events/{id}/copy` — глубокое дублирование (event + posters + реф-программа + conf_* + broadcast_templates). При копировании conf_conferences исключается колонка `id` (использует sequence).
- [x] UI кнопка 📋 «Скопировать» в списках мероприятий и конференций
- [x] Backend `POST /events/{id}/referral/import` — импорт реф-программы из другого события клиента
- [x] UI кнопка «Импортировать из другого события» в вкладке Реф-программа

### 2.10 Управление статусом участника + slug с кодом ✅
- [x] Backend `PATCH /api/v1/events/{event_id}/participants/{participant_id}` (`is_registered`)
- [x] Backend `GET /api/v1/events/{id}/participants?registered=all|yes|no` + `counts`
- [x] Frontend: общий компонент `<EventParticipants />` с фильтр-таблетками и чекбоксом
- [x] Подключение во вкладке «Участники» карточки мероприятия и в `ParticipantsTab` конференции
- [x] Уникальный slug = `slugify(title)-<5 случайных символов>` (без коллизий и счётчиков `-1`/`-2`)

### 2.8 Рассылки на уровне мероприятия
- [ ] Шаблоны и очередь — переиспользовать существующую систему рассылок (как в конференциях), привязать к `event_id`
- [ ] UI: вкладка «Рассылки» в карточке мероприятия

### 2.9 Mini App — реф-программа участника
- [ ] Если у события есть реф-программа — показывать прогресс (сколько друзей привёл, до какого порога осталось)
- [ ] Кнопка «Поделиться» — отдаёт случайную картинку из «Материалов» + текст-анонс с реф-кодом
- [ ] При получении подарка — показ в Mini App + сообщение от бота

### 2.11 Экосистема клиента — визитка + продукты (новое 2026-04-27)

> Эта вкладка отображается в Хабе организатора (Mini App) — показывает участникам кто такой клиент и что у него можно купить/получить.

**База данных (миграция 039):**
- [ ] Поля в `clients`: `bio TEXT`, `profile_photo_url TEXT`, `positioning TEXT` (одна строка позиционирования), `achievements JSONB` (массив `[{label, value}]`), `social_links JSONB` (`{instagram, telegram, youtube, vk, website}`)
- [ ] Новая таблица `client_offerings`:
  ```
  id, client_id → clients
  title, description, action_url
  is_paid BOOL                 ← делит на «Платно» / «Бесплатно»
  cover_url                    ← опционально
  sort_order INT
  created_at, updated_at
  ```
- [ ] Поле `events.successor_event_id` → `events(id)` ON DELETE SET NULL — какое событие предлагать после завершения

**Backend API:**
- [ ] `GET /api/v1/public/clients/{client_id}/profile` — биография + соцсети + регалии
- [ ] `GET /api/v1/public/clients/{client_id}/offerings` — продукты с разделением платно/бесплатно
- [ ] `PATCH /api/v1/clients/me/profile` — клиент редактирует свою визитку
- [ ] `GET/POST/PATCH/DELETE /api/v1/client-offerings` — CRUD по продуктам

**Дашборд клиента (готово 2026-04-27):**
- [x] Страница `/dashboard/mini-app` — заголовок «Настройка Mini App» + подсказка «Что видят участники в Telegram». Две вкладки:
  - «Визитка» — фото (URL), позиционирование, биография, регалии (label/value), соцсети (Telegram/Instagram/YouTube/VK/website)
  - «Продукты» — карточки с разделением «💼 Платно» / «📄 Бесплатно», CRUD через модалку
- [x] Сайдбар: новая секция «MINI APP» с пунктом «Настройка Mini App» (иконка `Smartphone` из lucide-react)
- [x] Кнопка «Превью» в шапке страницы → открывает Mini App в новой вкладке (`/tg/`)

**Открытое:**
- [ ] Загрузка фото клиента и обложек продуктов через `<FileUploader />` (сейчас по URL — нужно расширить `client_files.kind` новым значением `client_photo` / `offering_cover` и добавить ключ R2 `clients/{cid}/profile/...`)

### 2.12 Проверка регистрации участника на событие (новое 2026-04-27, открыто)

> Контекст: участник прошёл регистрацию в Mini App (или нет) — нужно надёжно знать факт регистрации. Сейчас `event_participants.is_registered` ставится только если он сам прошёл RegistrationFlow в Mini App. Если регистрация шла через GetCourse / Salebot / другой канал — статус не меняется.

- [ ] Решить: фоновый агент-воркер (Celery beat) или диалог в чат-боте?
  - **Вариант А — фоновый агент:** периодически опрашивает GetCourse / Salebot API → выявляет новые регистрации → проставляет `is_registered = true` для контактов где совпал email/phone
  - **Вариант Б — бот в Telegram:** бот сам спрашивает участника «Вы зарегистрировались на событие?» с кнопками «Да» / «Ещё нет» → прямое подтверждение
- [ ] Когда выбран вариант — задизайнить расписание / триггеры / источники проверки
- [ ] Реализовать и запустить на dev

### 2.10 Идеи на будущее (не в MVP)
- [ ] Обложка/превью лид-магнита (картинка) — пока без
- [ ] Автогенерация именных сертификатов (аватарка участника + имя на шаблоне через Pillow + Telegram `getUserProfilePhotos`)
- [ ] Промокоды для бизнес-акций (отдельный тип лид-магнита с лимитом использований и сроком действия)
- [ ] Модуль «Акции» (для магазинов, кафе, бизнесов с реф-механикой через промокоды)
- [ ] Модули «Премии» и «Турниры»

---

## ЭТАП 3 — ПЛАТФОРМА (после рефералки)

> Цель: другие клиенты могут самостоятельно зарегистрироваться и создать своё событие

- [ ] Страница регистрации нового клиента работает полностью (email-верификация)
- [ ] Тарифы и paywall (ЮKassa / Stripe)
- [ ] Партнёрская программа — коды партнёров, статистика привлечённых клиентов
- [ ] Панель администратора — полное управление платформой

### 3.X Реферальная программа самого ПЛЮСОНа (идея, нужно решить)

**Суть:** ПЛЮСОН должен сам пользоваться своим продуктом для привлечения новых клиентов. Каждый существующий участник или клиент может пригласить нового **клиента** (организатора) и получить за это бонус.

**Проблема, которую надо решить:**
1. **Куда вписать в Mini App** для участника (чтобы не запутать — у него уже есть реф-программы внутри событий клиентов)
2. **Где настраивать в вебе** — в админ-панели сервиса? в кабинете самой Маргариты как «системного клиента»?
3. **Что давать в бонус** клиенту, который привёл другого клиента — продление beta? скидку? кешбэк?

**Предложение по архитектуре (есть smysl обсудить):**

ПЛЮСОН = клиент №1 в собственной системе (ест свою собаку):
- Создаём специальное событие у Маргариты «Стать клиентом ПЛЮСОН» (вебинар-демо или просто landing)
- К нему — обычная реф-программа с подарками: 1 приглашённый клиент → бонус 1, 5 → бонус 5, и т.д.
- Реф-механика уже работает, не надо писать с нуля
- В админ-панели только один новый параметр: `clients.is_system = true` (специальная пометка)

**Куда вписать в Mini App для участника (плавно, без отдельной вкладки):**

Внутри уже существующей рекламной вкладки «ПЛЮСОН» (см. mockup_hub_selector.html, экран 2) добавить блок:
> «Вы можете заработать → расскажите про ПЛЮСОН организатору, которого знаете. Если зарегистрируется — получите [бонус]. Ваша ссылка: ...»

Это органично вписывается, ничего нового создавать не надо.

**Куда вписать в кабинете клиента:**

Раздел «Партнёрство» или «Пригласить клиента» в сайдбаре кабинета. Клиент видит свою реф-ссылку на регистрацию → копирует в свои каналы → при регистрации нового клиента по ссылке получает бонус (продление beta-периода / скидку / другое).

**Что записать в админ-панели:**
- Текст реф-программы для клиентов (welcome_text, share_text)
- Размер бонуса (например `+30 дней beta` или `−20% к первому платежу`)
- Список партнёров (кто привёл кого) — отчёт

**Открытые вопросы:**
- Как технически сейчас отличить «приглашение клиентом клиента» (B2B-реф) от обычной «участник пригласил участника» (B2C-реф внутри событий)?
- Нужна ли отдельная таблица `client_referrals` или хватит существующей `referral_events` с пометкой типа?
- Бонус начисляется при регистрации или при первом платеже клиента?

→ Подробное обсуждение и история решений: [memory/idea_plusson_referrals.md](../.claude/projects/-Users-macbookair-Documents-projects-referalka/memory/idea_plusson_referrals.md)

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

Полная иерархия после миграций 033/034/036:
- `platforms` — справочник платформ (telegram/vk/max + метаданные).
- `contacts` — ЧЕЛОВЕК (один на клиента, ref_code, email, phone).
- `platform_users` — АККАУНТ человека на платформе (один человек может иметь несколько идентичностей: TG + VK).
- `channels` — каналы клиента (его боты/группы).
- `platform_user_channels` — подписка идентичности на канал клиента.

Терминология которую нужно соблюдать везде:
- **Клиенты** → таблица `clients` (пользователи платформы ПЛЮСОН)
- **Контакты** → таблица `contacts` (все люди в базе Клиента, после миграции 036)
- **Идентичности** → таблица `platform_users` (аккаунт человека на платформе)
- **Коллабораторы** → таблица `collaborators` (подмножество Контактов: спикеры, партнёры)
- **Спикеры** → таблица `conf_speaker_events` (роль Коллаборатора в конкретном событии)
- **Участники** → таблица `event_participants` (Контакты зарегистрированные в событии)

### Иерархия сущностей

```
platforms (справочник)
    ↑
Контакты (contacts) — человек
    ├── Идентичности (platform_users) — TG/VK/MAX-аккаунты человека
    │       └── Подписки (platform_user_channels) — на каналы клиента
    ├── Коллабораторы (collaborators) ← подмножество Контактов (FK contact_id)
    │       └── Спикеры (conf_speaker_events) ← роль в конкретном событии
    └── Участники (event_participants) ← Контакты в событии (FK contact_id)
```

### Целевая структура таблиц (после миграции 036)

**`platforms` — справочник платформ**
```
platforms
├── slug PRIMARY KEY  ← 'telegram' | 'vk' | 'max'
├── display_name      ← 'Telegram' | 'VK' | 'MAX'
├── icon_url, color_hex
├── id_format         ← 'numeric' | 'string' (формат platform_user_id)
├── max_message_length
├── supports_buttons, supports_photo, supports_video
├── api_base_url
└── is_active, sort_order
```

**`clients` — Клиенты ПЛЮСОН**
```
clients
├── id, email, name, phone, telegram_username
├── password_hash, tariff_slug, partner_code
├── test_telegram_ids TEXT[]
├── trial_ends_at, is_active
└── ❌ bot_token — переехал в channels (миграция 033)
```

**`channels` — каналы доставки (боты, группы VK, каналы Max)**
```
channels
├── id, client_id → clients
├── platform_slug → platforms(slug)  ← FK на справочник (036)
├── display_name, handle, bot_token, is_active
```

**`contacts` — Контакт (ЧЕЛОВЕК), миграция 036**
```
contacts
├── id, client_id → clients
├── name, email, email_normalized, phone, phone_normalized
├── tags JSONB, utm_source, salebot_id, last_contact_at
├── ref_code UNIQUE                       ← переехал из platform_users
├── first_referrer_contact_id → contacts  ← кто впервые привёл
├── merged_into → contacts                ← soft-delete при ручном мердже
├── merged_ref_codes JSONB                ← реф-коды слитых контактов
└── is_active
```

**`platform_users` — Идентичность контакта на платформе, миграция 036 переосмыслена**
```
platform_users
├── id, contact_id → contacts             ← НОВ: связь с человеком
├── platform_slug → platforms(slug)       ← возвращена в 036, FK на справочник
├── platform_user_id (TEXT)               ← tg_id / vk_id / max_id
├── username, first_name, last_name       ← как они в этой платформе
├── platform_meta JSONB
├── UNIQUE(contact_id, platform_slug)     ← один контакт — одна идентичность на платформу
├── UNIQUE(client_id, platform_slug, platform_user_id)
└── ❌ email/phone/tags/ref_code/first_referrer_*/utm_source/salebot_id/last_contact_at — переехали в contacts
```

**`platform_user_channels` — подписка идентичности на канал**
```
platform_user_channels
├── id, platform_user_id → platform_users, channel_id → channels
├── platform_slug → platforms(slug)       ← дубль для составного FK
├── is_unsubscribed, subscribed_at, unsubscribed_at
├── UNIQUE(platform_user_id, channel_id)
└── Составные FK: (platform_user_id, platform_slug) и (channel_id, platform_slug)
```

**`collaborators` — Коллабораторы (миграция 036: переключено на contact_id)**
```
collaborators
├── id, contact_id → contacts             ← НОВ: было platform_user_id
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
├── id, speaker_id → collaborators, event_id → events
├── role, gift_*, poster_url, partner_url, extra_info
├── referrer_ref_code TEXT  ← кто привёл спикера (резолв через contacts.ref_code)
├── bot_in_channel BOOLEAN, is_visible, sort_order
└── UNIQUE(speaker_id, event_id)
```

**`event_participants` — Участники конкретного события (миграция 036: переключено на contact_id)**
```
event_participants
├── id, event_id → events
├── contact_id → contacts                 ← НОВ: было platform_user_id
├── referrer_participant_id → event_participants
├── referrer_ref_code TEXT  ← per-event реферер (резолв через contacts.ref_code)
├── is_registered BOOL, is_in_chat BOOL
├── registered_at, activated_at
└── UNIQUE(event_id, contact_id)
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
