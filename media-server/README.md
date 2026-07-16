# PLUSSON MediaMTX — media-сервер вебинарных комнат

Принимает RTMP-поток от видеокодера (Zoom Custom Streaming / OBS) и раздаёт его
зрителям как **HLS**. Отдельный процесс на проде (как `wa-bridge/`), основной стек
(api/celery/bot/web) не задевает.

```
Zoom/OBS ──RTMP──► MediaMTX :1935 ──HLS──► nginx /hls/ ──► браузер зрителя
                        │
                        └── runOnPublish/Unpublish ──► бэкенд (проверка ключа + статус комнаты)
```

## Что клиент видит в дашборде

- **RTMP-адрес:** `rtmp://pluson.ru:1935/live/{stream_key}`
- **Ключ трансляции:** `{stream_key}` (вставляет в Zoom → «Трансляция на пользовательскую
  платформу» / Custom Live Streaming, либо в OBS → Настройки → Вещание).
- **Зритель** смотрит на `https://pluson.ru/webinar/{slug}/{day}` — плеер тянет
  `https://pluson.ru/hls/{stream_key}/index.m3u8`.

## Установка на прод (разово, вне живого события)

```bash
# 1. Скачать бинарник MediaMTX (Linux amd64)
cd /var/www/plusson/media-server
MTX_VER=$(curl -s https://api.github.com/repos/bluenviron/mediamtx/releases/latest | grep -oP '"tag_name": "\K[^"]+')
curl -L -o mediamtx.tar.gz "https://github.com/bluenviron/mediamtx/releases/download/${MTX_VER}/mediamtx_${MTX_VER}_linux_amd64.tar.gz"
tar xzf mediamtx.tar.gz mediamtx      # достаём только бинарник (конфиг у нас свой — mediamtx.yml)
rm mediamtx.tar.gz
chmod +x mediamtx

# 2. .env с общим секретом (тот же токен в backend .env как WEBINAR_BRIDGE_TOKEN)
echo "MTX_BRIDGE_TOKEN=$(openssl rand -hex 24)" > .env
#    → скопировать это же значение в backend .env: WEBINAR_BRIDGE_TOKEN=...

# 3. systemd
cp plusson-mediamtx.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now plusson-mediamtx
systemctl status plusson-mediamtx

# 4. nginx — вставить содержимое nginx-hls.conf в server{} блок pluson.ru, затем:
nginx -t && systemctl reload nginx

# 5. firewall — открыть RTMP-порт наружу
ufw allow 1935/tcp
```

## Порты

| Порт | Назначение | Наружу? |
|---|---|---|
| 1935 | RTMP-вход от видеокодера | да (ufw allow) |
| 8888 | HLS-выход (только localhost, nginx проксирует) | нет |
| 9997 | локальный API MediaMTX (мониторинг) | нет |

## Проверка ключа при публикации

MediaMTX на `runOnPublish` дёргает бэкенд
`POST /api/v1/internal/webinar/stream/publish?path=live/{key}` с заголовком
`X-Bridge-Token`. Бэкенд проверяет, что `{key}` есть в активной `webinar_rooms`,
и ставит комнату в статус `live`. Неизвестный ключ → бэкенд вернёт !=200 → MediaMTX
отклонит публикацию (чужой не зальёт поток). На `runOnUnpublish` — комната → `ended`
+ редирект зрителей на `redirect_url`.

## Профи vs Экстра

Media-сервер нужен только для **Экстра** (своя комната, `stream_type='encoder'`).
На **Профи** (`stream_type='external_link'`) поток идёт мимо нас — кнопка ведёт на
стороннюю комнату, MediaMTX не задействован.
