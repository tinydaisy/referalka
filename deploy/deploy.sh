#!/bin/bash
# ПЛЮСОН Deploy Script
# Автоматический деплой при push на main ветку.
# Все сервисы крутятся под systemd — рестартим их через `systemctl restart`,
# не через pkill+nohup (иначе systemd рестартанёт второй раз → конфликты).

set -e

PROJECT_DIR="/var/www/plusson"
LOG="/var/log/plusson-deploy.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; echo "$1"; }

cd "$PROJECT_DIR"

log "===== Deploy started ====="

# 1. Pull из main
log "Pulling from main..."
git fetch origin main
git reset --hard origin/main

# 2. Backend (Python) — обновляем зависимости
# ⚠️ venv лежит в КОРНЕ проекта (/var/www/plusson/venv), а не в backend/ —
# так же, как его зовёт plusson-api.service. Путь backend/venv ломал деплой с 14.08.
log "Updating backend deps..."
cd "$PROJECT_DIR/backend"
source "$PROJECT_DIR/venv/bin/activate"
pip install -q -r requirements.txt

# 3. Web (Next.js) — собираем (рестарт сервиса ниже)
log "Building web..."
cd "$PROJECT_DIR/web"
npm install -q
npm run build

# 4. Mini App (Vite) — собираем dist/. Раздаётся через nginx, рестарт не нужен.
log "Building mini-app..."
cd "$PROJECT_DIR/mini-app"
npm install -q
npm run build

# 5. Рестарт всех сервисов через systemd
log "Restarting services..."
systemctl restart plusson-api || true
systemctl restart plusson-bot || true
systemctl restart plusson-web || true
# Celery: на dev сервис называется plusson-celery-worker, на prod — plusson-celery.
# Пробуем оба имени — сработает то, что существует.
systemctl restart plusson-celery 2>/dev/null || true
systemctl restart plusson-celery-worker 2>/dev/null || true
systemctl restart plusson-celery-beat 2>/dev/null || true

log "===== Deploy completed successfully ====="
