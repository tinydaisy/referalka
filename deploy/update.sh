#!/bin/bash
# ═══════════════════════════════════════════
# PLUSSON — обновление кода на сервере
# Запускать когда хочешь задеплоить изменения
# ═══════════════════════════════════════════

set -e
cd /var/www/plusson

echo "=== Обновляем код ==="
git pull origin main

echo "=== Обновляем зависимости ==="
source venv/bin/activate
pip install -r backend/requirements.txt

echo "=== Перезапускаем сервисы ==="
systemctl restart plusson-api
systemctl restart plusson-bot

echo "✅ Обновление завершено"
systemctl status plusson-api --no-pager
