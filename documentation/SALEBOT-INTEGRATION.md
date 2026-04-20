# Интеграция с Salebot

## Вебхук регистрации участника

Вызывать при каждом входе пользователя в бот.

**URL:** `https://pluson.margoforbs.ru/api/v1/integrations/salebot/register`  
**Метод:** POST-json  
**Заголовок запроса (в формате JSON):**
```json
{"Content-Type": "application/json", "X-Salebot-Secret": "PkaxG2xLXq3SxllWm27_60ERAGLWwrS18BUFV0rrWWw"}
```

**JSON параметры:**
```json
{
  "client_id": 1,
  "platform": "telegram",
  "platform_user_id": "#{platform_id}",
  "username": "#{tg_username}",
  "first_name": "#{full_name}",
  "last_name": "",
  "salebot_id": "#{client_id}",
  "event_id": "4",
  "status": "interested"
}
```

**Переменные Salebot:**
| Переменная Salebot | Что это |
|---|---|
| `#{platform_id}` | Telegram ID пользователя |
| `#{tg_username}` | @username в Telegram |
| `#{full_name}` | Имя пользователя |
| `#{client_id}` | ID подписчика в Salebot |

**Константы (зашить в настройках):**
| Поле | Значение |
|---|---|
| `client_id` | `1` (ID клиента в PLUSSON) |
| `event_id` | `4` (ID конференции ivision-7) |

**Сохраняемые значения (без пробелов вокруг ->):**
```
ok->ok
pluson_id->pluson_id
participant_id->participant_id
ref_code->ref_code
```

**Ответ сервера:**
```json
{
  "ok": 1,
  "pluson_id": "3",
  "participant_id": "2",
  "ref_code": "kwwlnk4u",
  "is_new_user": 1,
  "is_new_participant": 1
}
```

**Статусы участника:**
- `interested` — зашёл в бот
- `registered` — зарегистрировался на событие
- `in_chat` — вступил в чат

---

## Важные заметки

- Если пользователь уже есть в базе — данные обновятся, дубль не создастся
- Статус обновляется только в сторону повышения: `interested` → `registered` → `in_chat`
- `event_id` передавать строкой `"4"`, не числом
- Заголовок писать в формате JSON одной строкой
- В "Сохраняемые значения" писать без пробелов вокруг `->`: `pluson_id->pluson_id`
