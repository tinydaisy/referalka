# ПЛЮСОН WhatsApp-мост

Node-сервис для отправки/чтения WhatsApp через [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).
Каждый клиент ПЛЮСОНа привязывает свой WhatsApp-аккаунт по QR-коду — **сессия на `client_id`**.

## Зачем отдельный сервис

WhatsApp (в отличие от TG/VK/MAX) не даёт бота с токеном — сообщения шлёт залогиненный
через WhatsApp Web клиент (headless Chromium). Python-бэкенд ходит к этому мосту по HTTP.

## Безопасность

- Слушает **только `127.0.0.1`** — наружу не торчит.
- Все эндпоинты (кроме `/health`) требуют заголовок `X-Bridge-Token` = `WA_BRIDGE_TOKEN`.

## Env

| Переменная | Дефолт | Смысл |
|---|---|---|
| `WA_BRIDGE_PORT` | `8790` | порт (localhost) |
| `WA_BRIDGE_TOKEN` | — | **обязателен**, общий секрет с бэкендом |
| `WA_BRIDGE_DATA` | `./data` | папка с сессиями (LocalAuth) |

## Установка (прод)

```bash
cd /var/www/plusson/wa-bridge
npm install --no-audit --no-fund
# в /var/www/plusson/wa-bridge/.env: WA_BRIDGE_TOKEN=<секрет>
systemctl enable --now plusson-wa-bridge
```

## HTTP API

`X-Bridge-Token` обязателен для всех, кроме `/health`.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/health` | — | `{ ok, sessions }` |
| POST | `/sessions/:clientId/start` | — | `{ ok, state }` |
| GET | `/sessions/:clientId/status` | — | `{ state }` |
| GET | `/sessions/:clientId/qr` | — | `{ state, qr }` (data:image PNG) |
| GET | `/sessions/:clientId/chats` | — | `[{ id, name, isGroup, unread }]` |
| POST | `/sessions/:clientId/send` | `{ chatId, text }` | `{ ok, id }` |
| POST | `/sessions/:clientId/logout` | — | `{ ok }` |

`state`: `none → starting → qr → authenticated → ready` (или `auth_failure` / `disconnected`).
Для отправки/чтения годится и `authenticated`, и `ready` (whatsapp-web.js иногда подвисает на `authenticated`).

`chatId`: `<номер>@c.us` (личный) или `<...>@g.us` (группа) — берётся из `/chats`.
