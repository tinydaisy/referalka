#!/bin/bash
# ═══════════════════════════════════════════
# PLUSSON — первоначальная настройка Beget VPS
# Запускать от root: bash setup_vps.sh
# ═══════════════════════════════════════════

set -e

echo "=== 1. Обновляем систему ==="
apt update && apt upgrade -y

echo "=== 2. Устанавливаем зависимости ==="
apt install -y python3 python3-pip python3-venv nginx redis-server git curl certbot python3-certbot-nginx

echo "=== 3. Создаём папку проекта ==="
mkdir -p /var/www/plusson
cd /var/www/plusson

echo "=== 4. Создаём виртуальное окружение Python ==="
python3 -m venv venv
source venv/bin/activate

echo "=== 5. Устанавливаем Python-зависимости ==="
pip install --upgrade pip
pip install -r backend/requirements.txt

echo "=== 6. Копируем конфиги systemd ==="
cp deploy/plusson-api.service /etc/systemd/system/
cp deploy/plusson-bot.service /etc/systemd/system/
systemctl daemon-reload

echo "=== 7. Копируем конфиг nginx ==="
cp deploy/nginx.conf /etc/nginx/sites-available/plusson
ln -sf /etc/nginx/sites-available/plusson /etc/nginx/sites-enabled/plusson
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== 8. Включаем автозапуск Redis ==="
systemctl enable redis-server
systemctl start redis-server

echo ""
echo "✅ Базовая настройка завершена!"
echo ""
echo "Следующие шаги:"
echo "  1. Скопируй backend/.env.example в backend/.env и заполни реальными ключами"
echo "  2. Запусти сервисы:"
echo "     systemctl enable --now plusson-api"
echo "     systemctl enable --now plusson-bot"
echo "  3. Настрой SSL:"
echo "     certbot --nginx -d api.plusson.app"
