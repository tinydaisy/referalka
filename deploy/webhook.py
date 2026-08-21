#!/usr/bin/env python3
"""
GitHub Webhook Receiver for ПЛЮСОН Deploy
Слушает на порту 9999 и автоматически деплоит при push на main
"""

import os
import sys
import hmac
import hashlib
import json
import subprocess
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

# Настройка логирования
logging.basicConfig(
    filename='/var/log/webhook.log',
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s'
)

# ⚠️ Секрет читается ТОЛЬКО из окружения (systemd Environment= или EnvironmentFile=).
# В коде его держать нельзя: репозиторий видят подрядчики, а знание секрета =
# возможность запустить деплой на проде поддельным запросом.
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
DEPLOY_SCRIPT = "/var/www/plusson/deploy/deploy.sh"

class WebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        """Обработчик POST запросов от GitHub"""
        if self.path != '/webhook':
            self.send_response(404)
            self.end_headers()
            return

        # Проверяем подпись
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        signature = self.headers.get('X-Hub-Signature-256', '')
        expected_sig = 'sha256=' + hmac.new(
            WEBHOOK_SECRET.encode(),
            body,
            hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(signature, expected_sig):
            logging.warning("Invalid signature from GitHub")
            self.send_response(401)
            self.end_headers()
            return

        # Парсим payload
        try:
            payload = json.loads(body.decode('utf-8'))
        except:
            self.send_response(400)
            self.end_headers()
            return

        # Проверяем что это push на main
        if payload.get('ref') == 'refs/heads/main':
            logging.info(f"Push detected from {payload.get('pusher', {}).get('name', 'unknown')}")

            # Запускаем деплой в отдельном потоке
            Thread(target=self.run_deploy).start()

            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'Deploy started')
        else:
            logging.info(f"Ignoring push to {payload.get('ref')}")
            self.send_response(200)
            self.end_headers()

    def run_deploy(self):
        """Запускает скрипт деплоя"""
        try:
            logging.info("Starting deployment...")
            result = subprocess.run(['bash', DEPLOY_SCRIPT], capture_output=True, timeout=600)

            if result.returncode == 0:
                logging.info("Deployment completed successfully")
            else:
                logging.error(f"Deployment failed with code {result.returncode}")
                logging.error(result.stderr.decode())
        except Exception as e:
            logging.error(f"Deploy error: {str(e)}")

    def log_message(self, format, *args):
        """Подавляем стандартные логи"""
        pass

if __name__ == '__main__':
    # Без секрета не стартуем: пустой секрет означал бы, что подпись подделает кто угодно.
    if not WEBHOOK_SECRET:
        logging.error("WEBHOOK_SECRET не задан в окружении — запуск отменён")
        print("WEBHOOK_SECRET не задан в окружении — запуск отменён", file=sys.stderr)
        sys.exit(1)

    # Слушаем только localhost: снаружи порт открывать не надо, GitHub приходит через nginx.
    server = HTTPServer(('127.0.0.1', 9999), WebhookHandler)
    logging.info("Webhook server started on 127.0.0.1:9999")
    server.serve_forever()
