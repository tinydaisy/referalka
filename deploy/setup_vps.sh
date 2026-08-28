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

# ⚠️⚠️ БЕЗ ЭТИХ ТРЁХ ВЕЩЕЙ САЙТ «ВИСИТ И ГРУЗИТСЯ БЕЗ СТИЛЕЙ на телефоне»
# при полностью исправном сервере (проверено на проде 28.08.2026). Подробности
# и команды проверки — CLAUDE.md, раздел «Скорость отдачи».
echo "=== 7.1 Сжатие ответов (стоковый gzip жмёт ТОЛЬКО html) ==="
cp deploy/nginx-gzip.conf /etc/nginx/conf.d/plusson-gzip.conf

echo "=== 7.2 OCSP stapling (иначе браузер сам ждёт ответа от УЦ) ==="
mkdir -p /etc/nginx/snippets
cp deploy/nginx-ssl-extra.conf /etc/nginx/snippets/plusson-ssl-extra.conf
echo "    ⚠️ подключить в каждом server-блоке 443, ПОСЛЕ options-ssl-nginx.conf:"
echo "        include /etc/nginx/snippets/plusson-ssl-extra.conf;"

echo "=== 7.3 Общие location публичных страниц ==="
cp deploy/nginx-public-locations.conf /etc/nginx/snippets/plusson-public-locations.conf

echo "=== 7.4 HTTP/2 во всех server-блоках на 443 ==="
# nginx 1.24: форма `listen 443 ssl http2;`. С 1.25.1 она устарела — там
# отдельная строка `http2 on;`, при обновлении ОС поправить.
for f in /etc/nginx/sites-enabled/* /etc/nginx/sites-available/*; do
    [ -f "$f" ] && sed -i 's/^\(\s*\)listen 443 ssl;/\1listen 443 ssl http2;/' "$f"
done

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
echo "  4. ПРОВЕРЬ скорость отдачи (иначе сайт будет висеть на телефонах):"
echo "     curl -s -o /dev/null --http2 -w 'HTTP/%{http_version}\\n' https://<домен>/   # → HTTP/2"
echo "     curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}\\n' \\"
echo "          https://<домен>/tg/assets/<файл>.js                                    # → ~100000, не ~380000"
echo "     curl -s -o /dev/null https://<домен>/ && sleep 3 && \\"
echo "       echo | openssl s_client -connect 127.0.0.1:443 -servername <домен> -status \\"
echo "         2>/dev/null | grep 'Cert Status'                                        # → good"
