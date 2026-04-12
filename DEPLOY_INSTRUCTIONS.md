# Инструкция по деплою ПЛЮСОН на сервере

## Шаг 1: Настройка сервера

```bash
# SSH на сервер
ssh root@194.156.119.17

# Создаем директорию проекта
mkdir -p /var/www/plusson
cd /var/www/plusson

# Клонируем репозиторий
git clone https://github.com/tinydaisy/referalka.git .

# Настраиваем права доступа
chmod +x deploy/deploy.sh
chmod +x deploy/webhook.py
```

## Шаг 2: Установка webhook сервера

```bash
# Копируем systemd сервис
cp deploy/plusson-webhook.service /etc/systemd/system/

# Перезагружаем systemd
systemctl daemon-reload

# Запускаем webhook
systemctl start plusson-webhook
systemctl enable plusson-webhook

# Проверяем статус
systemctl status plusson-webhook
```

## Шаг 3: Настройка GitHub Webhook

1. Зайди в https://github.com/tinydaisy/referalka/settings/hooks
2. Нажми "Add webhook"
3. **Payload URL:** `http://194.156.119.17:9999/webhook`
4. **Content type:** `application/json`
5. **Secret:** Используй любой секрет, потом обнови в `deploy/webhook.py`
6. **Which events:** Выбери "Push events"
7. Сохрани

## Шаг 4: Обновление секрета в webhook сервере

Отредактируй `deploy/webhook.py`:

```python
WEBHOOK_SECRET = "твой-секрет-из-github"  # Обнови это
```

Потом пушь изменения:

```bash
git add deploy/webhook.py
git commit -m "Update webhook secret"
git push
```

Webhook автоматически перезагрузится и установит новый секрет.

## Проверка работы

```bash
# Смотри логи webhook сервера
tail -f /var/log/webhook.log

# Смотри логи деплоя
tail -f /var/log/plusson-deploy.log

# Смотри логи приложений
tail -f /var/log/fastapi.log
tail -f /var/log/nextjs.log
tail -f /var/log/bot.log
```

## Как работает деплой

1. Ты пушишь код в `main` ветку на GitHub
2. GitHub отправляет webhook на сервер (порт 9999)
3. Webhook сервер проверяет подпись и запускает `deploy/deploy.sh`
4. Скрипт:
   - Git pull новых изменений
   - Перестартует backend (FastAPI)
   - Перестартует бота
   - Перестартует frontend (Next.js)
   - Пересобирает mini-app

Всё происходит автоматически, никаких ручных действий не нужно!

## Решение проблем

### Webhook не получает события

```bash
# Проверь что сервис запущен
systemctl status plusson-webhook

# Проверь что порт 9999 открыт
lsof -i :9999

# Проверь настройки GitHub webhook (Settings → Webhooks)
```

### Деплой зависает

```bash
# Убей зависший деплой процесс
pkill -f deploy.sh
pkill -f uvicorn
pkill -f "next dev"
pkill -f "bot.main"
```

### Неправильная подпись

Убедись что секрет в `deploy/webhook.py` совпадает с секретом в GitHub webhook settings.
