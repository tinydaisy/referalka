#!/bin/bash

# ПЛЮСОН Deploy Script
# Автоматический деплой при push на main ветку

set -e

PROJECT_DIR="/var/www/plusson"
LOG_FILE="/var/log/plusson-deploy.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting deployment..." >> $LOG_FILE

# Переходим в директорию проекта
cd $PROJECT_DIR

# Обновляем код с GitHub
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pulling from main..." >> $LOG_FILE
git fetch origin main
git reset --hard origin/main

# Деплой backend
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deploying backend..." >> $LOG_FILE
cd $PROJECT_DIR/backend
source venv/bin/activate
pip install -q -r requirements.txt
pkill -f "uvicorn app.main" || true
sleep 1
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2 > /var/log/fastapi.log 2>&1 &

# Деплой бота
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deploying bot..." >> $LOG_FILE
pkill -f "bot.main" || true
sleep 1
nohup python -m bot.main > /var/log/bot.log 2>&1 &

# Деплой frontend
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deploying frontend..." >> $LOG_FILE
cd $PROJECT_DIR/web
pkill -f "next dev\|next start" || true
sleep 2
npm install -q
nohup npm run dev > /var/log/nextjs.log 2>&1 &

# Деплой mini app
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Building mini app..." >> $LOG_FILE
cd $PROJECT_DIR/mini-app
npm install -q
npm run build
cp -r dist/* /var/www/plusson/mini-app/dist/

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deployment completed successfully!" >> $LOG_FILE
