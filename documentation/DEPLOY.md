# DEPLOY.md — Деплой ПЛЮСОН

> Пошаговый план развёртывания. Шаги отмечены: 🖥 — делает Клод, 👤 — делаешь ты (в браузере или терминале).

---

## Обзор архитектуры

```
Supabase (DB)      Beget VPS              Vercel
    │                   │                    │
    │              FastAPI :8000         web/ (Next.js)
    │         ← → Bot (aiogram)      mini-app/ (Vite React)
    └─────────────────────────────────────────┘
                  общая база данных
```

---

## Шаг 1 — Supabase (база данных)

### 👤 Создай проект

1. Зайди на [supabase.com](https://supabase.com) → Sign In → New Project
2. **Region:** EU (Frankfurt) — ближайший к России
3. **Database Password:** придумай и сохрани в пароли
4. Дождись запуска (~2 минуты)

### 👤 Применить миграции

1. Слева в меню → **SQL Editor**
2. Открой первый файл с компьютера, скопируй всё содержимое, вставь → Run:
   - `db/migrations/001_schema.sql` — создаёт все таблицы
3. Затем так же второй файл:
   - `db/migrations/002_indexes.sql` — создаёт индексы
4. Затем начальные данные:
   - `db/seed/001_initial.sql` — тариф Beta + клиент Маргарита

### 👤 Скопируй ключи

В Supabase: **Settings → API**

| Что скопировать | Куда вставить в .env |
|---|---|
| Project URL | `SUPABASE_URL` |
| anon / public key | `SUPABASE_KEY` |
| service_role key | `SUPABASE_SERVICE_KEY` |

В Supabase: **Settings → Database → Connection string → URI**
- Скопируй строку → вставь в `DATABASE_URL` (замени `[YOUR-PASSWORD]` на свой пароль)

---

## Шаг 2 — BotFather (Telegram бот)

### 👤 Зарегистрируй бота

1. Открой Telegram → найди [@BotFather](https://t.me/BotFather)
2. Напиши `/newbot`
3. Имя бота: `ПЛЮСОН` (или любое)
4. Username: `pluson_bot` (или другой свободный, заканчивается на `_bot`)
5. BotFather пришлёт **токен** — скопируй его в `TELEGRAM_BOT_TOKEN` в `.env`

### 👤 Зарегистрируй Mini App

После деплоя mini-app на Vercel (Шаг 4):

1. BotFather → `/newapp`
2. Выбери своего бота
3. Укажи URL деплоя mini-app (например `https://plusson-mini.vercel.app`)
4. После регистрации обнови `web/public/redirect_web_app/app_config.js`:
   ```javascript
   var APP_CONFIG = {
     tg: 'https://t.me/pluson_bot/pluson'
   };
   ```

---

## Шаг 3 — Beget VPS (бэкенд)

### 👤 Купи и настрой VPS

1. Зайди на [beget.com](https://beget.com) → VPS → минимальный тариф
2. ОС: **Ubuntu 22.04 LTS**
3. После оплаты получишь IP и root-пароль

### 👤 Загрузи проект на сервер

Открой Терминал на Mac и выполни команды по очереди (замени `123.123.123.123` на реальный IP):

```bash
# Подключись к серверу
ssh root@123.123.123.123

# Создай папку и уйди
mkdir -p /var/www/plusson && exit
```

Затем загрузи файлы (в терминале на Mac, находясь в папке проекта):
```bash
scp -r backend deploy db root@123.123.123.123:/var/www/plusson/
```

### 👤 Запусти первоначальную настройку

```bash
# Подключись снова
ssh root@123.123.123.123

# Перейди в папку проекта
cd /var/www/plusson

# Запусти скрипт настройки
bash deploy/setup_vps.sh
```

### 👤 Создай файл с ключами

На сервере:
```bash
cp /var/www/plusson/backend/.env.example /var/www/plusson/backend/.env
nano /var/www/plusson/backend/.env
```

Заполни все строки реальными значениями из Шагов 1-2. Сохрани: `Ctrl+O`, `Enter`, `Ctrl+X`.

### 👤 Запусти сервисы

```bash
systemctl enable --now plusson-api
systemctl enable --now plusson-bot

# Проверить что работает:
systemctl status plusson-api
systemctl status plusson-bot

# Логи:
journalctl -u plusson-api -f
```

### 👤 Настрой SSL (HTTPS)

Сначала направь домен `api.plusson.app` на IP сервера (в DNS настройках домена).
Подожди 5-15 минут. Затем:
```bash
certbot --nginx -d api.plusson.app
```

---

## Шаг 4 — Vercel (веб-кабинет и mini-app)

### 👤 Задеплой веб-кабинет

1. Зайди на [vercel.com](https://vercel.com) → Add New → Project
2. Импортируй репозиторий GitHub (нужно сначала залить проект на GitHub)
3. **Root Directory:** `web`
4. **Environment Variables** добавь:
   - `NEXT_PUBLIC_API_URL` = `https://api.plusson.app`
   - `NEXT_PUBLIC_APP_URL` = `https://plusson.app`
5. Deploy

### 👤 Задеплой Mini App

1. Vercel → Add New → Project → тот же репозиторий
2. **Root Directory:** `mini-app`
3. **Environment Variables:**
   - `VITE_API_URL` = `https://api.plusson.app`
   - `VITE_APP_URL` = `https://plusson.app`
4. Deploy

---

## Шаг 5 — Первый вход

### 👤 Установи пароль для Маргариты

После деплоя бэкенда вызови API (в браузере или Postman):

```
POST https://api.plusson.app/api/v1/auth/set-password
Body: {
  "email": "margarita.vl2011@gmail.com",
  "password": "твой-пароль"
}
```

Или через curl:
```bash
curl -X POST https://api.plusson.app/api/v1/auth/set-password \
  -H "Content-Type: application/json" \
  -d '{"email": "margarita.vl2011@gmail.com", "password": "твой-пароль"}'
```

### 👤 Создай первого администратора

В Supabase SQL Editor выполни (замени данные):
```sql
INSERT INTO admins (email, name, password_hash, is_superadmin)
VALUES ('admin@plusson.app', 'Администратор', 'ЗАМЕНИТЬ_НА_ХЕШ', TRUE);
```

> Хеш пароля — попроси Клода сгенерировать через bcrypt

---

## Что делать при обновлениях

1. Запушить изменения на GitHub
2. Vercel обновится автоматически
3. На VPS — подключись и запусти:
   ```bash
   cd /var/www/plusson && bash deploy/update.sh
   ```

---

## Проверка работы

После деплоя проверь:

- [ ] `https://api.plusson.app/health` — должен вернуть `{"status": "healthy"}`
- [ ] `https://api.plusson.app/docs` — Swagger с документацией API
- [ ] Веб-кабинет открывается и страница логина видна
- [ ] Mini App открывается в Telegram
- [ ] Бот отвечает на `/start`
