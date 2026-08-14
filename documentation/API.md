# API — Справочник эндпоинтов

Базовый URL: `https://pluson.margoforbs.ru/api/v1` (прод) / `https://dev.pluson.margoforbs.ru/api/v1` (dev)

> Полная карта endpoints — в [BACKEND-PLAN.md](BACKEND-PLAN.md). В этом файле — специфические интеграции (Salebot, отправка из бэка в Telegram).

---

## Лид-магниты и реф-программа (актуально с 26.04.2026)

### Лид-магниты — общая база per-client
```
GET    /api/v1/lead-magnets                        — список
POST   /api/v1/lead-magnets                        — создать (name, description, url)
GET    /api/v1/lead-magnets/{id}
PATCH  /api/v1/lead-magnets/{id}
DELETE /api/v1/lead-magnets/{id}
```

### Реф-программа события (вкладки в карточке)
```
GET/POST/PATCH/DELETE  /api/v1/events/{id}/posters             — афиши (h/v ориентация)
GET/PUT                /api/v1/events/{id}/referral/settings   — welcome_text, share_text
GET/POST/PATCH/DELETE  /api/v1/events/{id}/referral/thresholds — пороги-подарки
GET/POST/DELETE        /api/v1/events/{id}/referral/materials  — картинки для шеринга

GET   /api/v1/events/{id}/referral/import-sources              — события-источники для импорта
POST  /api/v1/events/{id}/referral/import {from_event_id}      — импорт реф-программы (REPLACE)
```

### Копирование события
```
POST /api/v1/events/{id}/copy
```
Возвращает новое событие со статусом `draft`, title с префиксом «Копия —», уникальным slug.
Копируется: events + posters + реф-программа + (для конф.) `conf_*` + `broadcast_templates`.

---

## Отправка карточки спикера в Telegram

**Endpoint:**
```
GET /events/{event_id}/conference/speakers/{speaker_event_id}/send-to-telegram
```

**Описание:**
Отправляет карточку спикера в Telegram-чат: афиша (фото) + текст с именем, ссылками, регалиями, темой лекции и подарками. Внизу кнопка «Программа конференции».

Используется в кнопках SaleBot — вызывается без авторизации, по GET-запросу.

**Параметры:**

| Параметр | Где | Тип | Описание |
|---|---|---|---|
| `event_id` | path | int | ID события в системе |
| `speaker_event_id` | path | int | ID записи спикера в событии (`event_collaborators.id`) |
| `chat_id` | query | string | Telegram ID получателя (пользователя) |

**Авторизация:** не требуется (публичный endpoint)

**Пример запроса:**
```
GET https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/6/send-to-telegram?chat_id=5725111966
```

**Ответ (успех):**
```json
{
  "ok": true,
  "speaker": "Ксения Баранова",
  "chat_id": "5725111966",
  "telegram_response": { ... }
}
```

**Ответ (ошибка):**
```json
{
  "detail": "Ошибка Telegram API: ..."
}
```

**Логика формирования текста:**
- Имя Фамилия
- Тг канал: `<ссылка>` (если есть)
- Нельзяграм: `<ссылка>` (если есть)
- *(пустая строка после ссылок)*
- Тема лекции: (не выводится для партнёров)
- *(пустая строка)*
- Темы выступления или «уточняется»
- *(пустая строка)*
- `· Регалия 1`
- `· Регалия 2`
- *(пустая строка)*
- `🎁 На эфире подарит: ...` (если есть)
- *(пустая строка)*
- `🏆Подарок для большого розыгрыша: ...` (если есть)

Если caption > 1024 символов (лимит Telegram): фото отправляется отдельно, текст — следующим сообщением.

**Бот-токен** берётся из поля `bot_token` таблицы `clients` для клиента-владельца события.

---

## Интеграция с SaleBot

### Что такое cse_id?

В URL используется **cse_id** — это ID записи спикера в конкретном событии (`event_collaborators.id`; таблицы `conf_speaker_events` не существует).  
Это **не** ID коллаборатора из глобальной базы. Один и тот же человек в разных конференциях имеет разные cse_id.

Для iViSiON-7 cse_id: от 2 до 22 (5 — «Опора России», без карточки спикера).

---

### Способ 1 — отдельная кнопка на каждого спикера

Самый простой вариант: на каждого спикера своя inline-кнопка с URL вида:

```
https://t.me/ivision_conf_bot?start=cse_id_6
```

где `6` — cse_id спикера (Ксения Баранова).

Тип кнопки: **URL** (не callback). Пользователь нажимает — открывает бота. Этот вариант **не** отправляет карточку автоматически, просто открывает бота с параметром.

---

### Способ 2 — универсальный обработчик callback (рекомендуется)

Один блок-обработчик на все кнопки спикеров. Кнопки делаются с типом **callback**, данные кнопки: `cse_id_6`, `cse_id_14` и т.д.

**Шаг 1. Создать inline-кнопки со спикерами**

Тип кнопки: **callback**  
Данные (callback_data): `cse_id_2`, `cse_id_3`, `cse_id_6` и т.д.  
Текст кнопки: имя спикера (например, «Ксения Баранова»)

**Шаг 2. Создать блок-обработчик callback**

| Настройка | Значение |
|---|---|
| Условие | `cse_id_\d+` |
| Выбор соответствия | Регулярное выражение |

**Калькулятор (код):**
```
cb_data2=findall('cse_id_\d+', tg_request, 0)
a=replace(cb_data2, "cse_id_", "", 1)
url='https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/#{a}/send-to-telegram?chat_id=#{platform_id}'
```

**Действие:** Отправка JSON-запроса  
**Метод:** GET  
**URL:** `#{url}`

После выполнения — карточка спикера с афишей и текстом автоматически отправляется пользователю от имени бота @ivision_conf_bot.

---

### Список URL для кнопок SaleBot — iViSiON-7 (event_id=4)

Подставьте вместо `{chat_id}` переменную SaleBot с Telegram ID пользователя (`#{platform_id}`).

| Спикер | URL |
|---|---|
| Марго Форбс | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/2/send-to-telegram?chat_id={chat_id}` |
| Яна Кондраченко | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/3/send-to-telegram?chat_id={chat_id}` |
| Любовь Алимова | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/4/send-to-telegram?chat_id={chat_id}` |
| Ксения Баранова | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/6/send-to-telegram?chat_id={chat_id}` |
| Анастасия Кириченко | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/7/send-to-telegram?chat_id={chat_id}` |
| Валерия Бочарникова | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/8/send-to-telegram?chat_id={chat_id}` |
| Виктория Иванова | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/9/send-to-telegram?chat_id={chat_id}` |
| Дмитрий Ледовских | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/10/send-to-telegram?chat_id={chat_id}` |
| Камилла Жибуля | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/11/send-to-telegram?chat_id={chat_id}` |
| Карина Тагирова | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/12/send-to-telegram?chat_id={chat_id}` |
| Марияна Анаэль | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/13/send-to-telegram?chat_id={chat_id}` |
| Настасья Белочкина | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/14/send-to-telegram?chat_id={chat_id}` |
| Наталья Сипайлова | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/15/send-to-telegram?chat_id={chat_id}` |
| Никита Метелица | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/16/send-to-telegram?chat_id={chat_id}` |
| Ольга Ушатова | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/17/send-to-telegram?chat_id={chat_id}` |
| Рамиля Шиманская | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/18/send-to-telegram?chat_id={chat_id}` |
| Роман Зайнеев и Артем Артемов | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/19/send-to-telegram?chat_id={chat_id}` |
| Светлана Мир | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/20/send-to-telegram?chat_id={chat_id}` |
| Сергей Анисимов | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/21/send-to-telegram?chat_id={chat_id}` |
| Элина Бутенко | `https://pluson.margoforbs.ru/api/v1/events/4/conference/speakers/22/send-to-telegram?chat_id={chat_id}` |

---

## Отправка программы конференции в Telegram

### GET `/api/v1/events/{event_id}/conference/send-schedule`

Публичный endpoint (без авторизации). Отправляет текст программы конференции с тремя inline-кнопками в Telegram-чат пользователю.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `event_id` | path (int) | ID события |
| `client_id` | query (int) | ID клиента-владельца события |
| `chat_id` | query (int) | Telegram ID получателя |

**Пример запроса:**
```
GET https://pluson.margoforbs.ru/api/v1/events/4/conference/send-schedule?client_id=1&chat_id=5725111966
```

**Что отправляет:**

```
ПРОГРАММА КОНФЕРЕНЦИИ:

ДЕНЬ 1 - 23 апреля
11:00 - 11:30: Открытие iViSiON-7 (Марго Форбс - организатор)
11:30 - 12:00: Название темы (Имя Фамилия)
14:10 - 14:40: Название темы (Имя Фамилия - хедлайнер)
...

ДЕНЬ 2 - 24 апреля
...
```

Роль пишется только для: `headliner` → «хедлайнер», `organizer` → «организатор», `partner` → «партнёр», `general_partner` → «генеральный партнёр».

Время переводится из UTC в МСК (UTC+3) автоматически.

**Кнопки (inline_keyboard):**
1. **ИНФОРМАЦИЯ О СПИКЕРАХ** → `https://t.me/ivision_conf_bot?start=spikers`
2. **ПОЛУЧИТЬ ЗАПИСИ И VIP-ТАРИФ** → `registration_url` из `conf_conferences`
3. **ЗАРЕГИСТРИРОВАТЬСЯ** → `registration_url` из `conf_conferences`

**bot_token** берётся из поля `bot_token` таблицы `clients` по `client_id`. Если не задан — из переменной окружения `TELEGRAM_BOT_TOKEN`.

**Успешный ответ:**
```json
{"ok": true, "chat_id": 5725111966, "days": 2, "telegram_response": {...}}
```

**Для SaleBot:**
```
https://pluson.margoforbs.ru/api/v1/events/#{pluson_conf_id}/conference/send-schedule?chat_id=#{platform_id}
```

---

## Отправка списка подарков розыгрыша в Telegram

### GET `/api/v1/events/{event_id}/conference/send-raffle-gifts`

Публичный endpoint (без авторизации). Отправляет нумерованный список подарков для розыгрыша с кнопкой в Telegram-чат.

**Параметры:**

| Параметр | Тип | Описание |
|---|---|---|
| `event_id` | path (int) | ID события |
| `client_id` | query (int) | ID клиента-владельца события |
| `chat_id` | query (int) | Telegram ID получателя |

**Пример запроса:**
```
GET https://pluson.margoforbs.ru/api/v1/events/4/conference/send-raffle-gifts?client_id=1&chat_id=5725111966
```

**Что отправляет:**

```
1.Название подарка (Имя Фамилия)
2.Название подарка (Имя Фамилия - хедлайнер)
3.Название подарка (Имя Фамилия - партнёр)
...
```

Имя спикера всегда **жирное**. Роль пишется только для: `headliner` → «хедлайнер», `partner` → «партнёр», `general_partner` → «генеральный партнёр». Берутся только спикеры с заполненным `gift_raffle_title`.

**Кнопка:** «Проверить/Получить билеты» → `https://t.me/ivision_conf_bot?start=check_get_bilets`

**bot_token** берётся из поля `bot_token` таблицы `clients` по `client_id`.

**Успешный ответ:**
```json
{"ok": true, "chat_id": 5725111966, "gifts_count": 14, "telegram_response": {...}}
```

**Для SaleBot:**
```
https://pluson.margoforbs.ru/api/v1/events/#{pluson_conf_id}/conference/send-raffle-gifts?chat_id=#{platform_id}
```
