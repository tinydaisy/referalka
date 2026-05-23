# Cloudflare — настройка для pluson.ru и поддоменов

Эта инструкция нужна когда:
- Подключаем новый домен или поддомен ПЛЮСОНа за Cloudflare
- Что-то перестало работать у пользователей с VPN
- Хотим продиагностировать «не открывается у части юзеров»

**Аккаунт Cloudflare для ПЛЮСОНа:** `margarita.forbs1@gmail.com` (НЕ `margarita.vl2011@gmail.com` — это отдельный аккаунт для R2-хранилища).

**Что сейчас за CF:** `pluson.ru`, `www.pluson.ru`, `dev.pluson.ru`, `ivision.pluson.ru`, `lever.pluson.ru` — все Proxied (оранжевая туча).

**Что НЕ за CF и почему:** `margoforbs.ru` (DNS на Vercel, у Vercel свой CDN — не нужен поверх него ещё один прокси). См. раздел «Когда CF не нужен» ниже.

---

## ⚠️ ОБЯЗАТЕЛЬНЫЕ настройки при подключении домена

Без них ломаются логин/куки/SSL. Проверяем КАЖДЫЙ раз когда добавляем новый домен:

### 1. SSL/TLS → Overview → режим **Full (strict)**
- Дефолт CF может быть `Flexible` или просто `Full` — это плохо
- `Full (strict)` = CF→origin по HTTPS + проверка валидного сертификата
- Без strict: куки `Secure` не передаются → логин не работает

### 2. SSL/TLS → Edge Certificates → **Always Use HTTPS = ON**
- Любой `http://` редиректится в `https://` на уровне CF
- Без этого юзеры с http:// в bookmark получают чистый HTML без redirect

### 3. SSL/TLS → Edge Certificates → **Minimum TLS Version = TLS 1.2**
- TLS 1.0/1.1 устарели, давно не нужны
- Не ставьте 1.3 — отрежет старые Android-устройства

### 4. DNS → каждая A-запись **Proxied (оранжевая туча)**
- Серая туча (DNS only) = трафик идёт напрямую на origin IP, CF не защищает
- Используется только для записей которые не должны проксироваться (CNAME на Vercel, GetCourse и т.п.)

---

## 🚫 КРИТИЧНО — настройки которые СЛОМАЮТ юзеров с VPN

Это самое больное место. Каждую из этих опций нужно либо ВЫКЛЮЧИТЬ, либо знать какой эффект она даёт.

### Speed → Optimization → Protocol Optimization → **HTTP/3 (with QUIC) = OFF**

> **Это та самая боль с 17 мая 2026.** При включённом HTTP/3 у ~20% юзеров с VPN из РФ Mini App «не открывался / белый экран / 10+ секунд». Causes: HTTP/3 работает через UDP; VPN-провайдеры (Happ, многие WireGuard/Outline) режут или плохо передают UDP. Safari iPhone агрессивно пробует QUIC при `alt-svc: h3` → зависает.

**Проверка:** `curl -sI https://pluson.ru/ | grep -i alt-svc` — если есть `alt-svc: h3=":443"`, HTTP/3 включён.

После выключения заголовок исчезает в течение 1-2 минут.

### Speed → Optimization → Protocol Optimization → **0-RTT Connection Resumption = OFF**

Дополнительная фишка которая иногда ломает соединения. На всякий случай выключаем.

### Security → Settings → **Browser Integrity Check = OFF**

Cloudflare смотрит на HTTP-заголовки браузера и блокирует «подозрительные». Telegram WebView + VPN exit-нода = часто срабатывает ложно. Заглушка «Access denied» юзеру.

### Security → Bots → **Bot Fight Mode = OFF**

На Free часто включён по умолчанию. Категоризирует VPN exit IPs как «боты» (потому что много людей с одного IP) и блокирует. Гарантированно отрезает значимую долю VPN-юзеров.

### Security → Settings → Security Level (если есть) = **Medium** или **Low**

Не ставить `High` или `Under Attack` без реального DDoS. `High` агрессивно challenge'ит подозрительный трафик.

---

## 🔄 Recipe — добавить новый поддомен за CF

Например: добавляем `новое.pluson.ru` который указывает на Beget VPS `194.156.119.17`.

### 1. В Cloudflare → `pluson.ru` → DNS → Add record
- Type: `A`
- Name: `новое` (без `.pluson.ru` — это добавится автоматически)
- IPv4: `194.156.119.17`
- Proxy status: 🟠 **Proxied**
- TTL: Auto
- **Save**

### 2. На Beget — создать nginx-конфиг + Let's Encrypt cert

Скелет (на примере `lever.pluson.ru`):

```bash
ssh root@194.156.119.17

# Временный HTTP-only конфиг для ACME-challenge
cat > /etc/nginx/sites-available/новое-pluson << 'NGINXEOF'
server {
    listen 80;
    server_name новое.pluson.ru;
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/новое-pluson /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Получить SSL
certbot certonly --nginx -d новое.pluson.ru --non-interactive \
  --agree-tos --email margarita.vl2011@gmail.com

# Дополнить конфиг для HTTPS (см. шаблон ниже)
# ... отредактировать конфиг с реальной логикой проксирования
nginx -t && systemctl reload nginx
```

Шаблон полного nginx-конфига с SSL — берите из [`/etc/nginx/sites-available/lever-pluson`](memory/server_access.md) или из этого репо.

### 3. Проверить

```bash
# DNS разошёлся?
dig +short новое.pluson.ru A
# Должны быть IP Cloudflare (104.21.x.x или 172.67.x.x)

# Через CF работает?
curl -sI https://новое.pluson.ru/ | grep -iE "server|cf-ray|http"
# Должны быть: server: cloudflare, cf-ray: ..., HTTP/2 200

# HTTP/3 НЕ должен быть (если глобально выключен)
curl -sI https://новое.pluson.ru/ | grep alt-svc
# Должно быть пусто
```

---

## ⛔ Когда CF НЕ нужен поверх

| Хостинг клиента | Нужен CF? | Почему |
|---|---|---|
| Beget, Reg.ru, Timeweb, любой ru-VPS без CDN | ✅ ДА | Один сервер в РФ, плохой пиринг с зарубежом |
| Vercel, Netlify, Cloudflare Pages | ❌ НЕТ | Сами глобальный CDN |
| GetCourse, Tilda, Taplink, Bizon360, Notion | ❌ НЕТ | За глобальным CDN (Qrator/свой) |
| AWS/GCP/Azure | ⚠️ Зависит | Если один регион — да; если за CloudFront/Cloud CDN — нет |

**Диагностика хостинга клиента:** `dig +short {домен} A` + `whois {ip}`. Если `netname=BEGET/REG/TIMEWEB` и `country=RU` — рекомендовать клиенту CF.

---

## 🔍 Диагностика «у меня не открывается»

### Шаг 1 — собрать инфу у пострадавшего юзера
- VPN-сервис (название) и страна exit-ноды
- Устройство (iPhone N / Android)
- Браузер vs Telegram WebView
- Что видит: белое / спиннер / ошибка с текстом / красная страница CF
- Telegram username (для поиска в наших логах)

### Шаг 2 — проверить блокирует ли CF

Cloudflare → Security → Analytics → Traffic за 24h. Смотрим:
- **Mitigated by Cloudflare** vs **Total** — если % высокий, CF блокирует
- **Source IPs** — есть ли наш юзер?
- **Top countries** — нет ли вашей страны?
- **Security actions → Block** — конкретные блокировки

Если % блокировок <1% — проблема НЕ в CF, копаем дальше.

### Шаг 3 — проверить заголовки

```bash
curl -sI https://pluson.ru/ | grep -iE "cf-cache|cf-ray|server|alt-svc"
```
- `server: cloudflare` — трафик идёт через CF ✅
- `cf-ray: ...-XXX` — какая edge-нода ответила (3-буквенный код города)
- `cf-cache-status: HIT/MISS/DYNAMIC` — кешируется ли
- `alt-svc: h3=":443"` — ОЙ! HTTP/3 включён, выключить!

### Шаг 4 — проверить origin на Beget

```bash
ssh root@194.156.119.17
# Логи запросов от пострадавшего (по User-Agent или времени)
grep "5938389914" /var/log/nginx/access.log  # tg_id или часть запроса
# Ошибки SSL/TLS
tail -200 /var/log/nginx/error.log | grep -iE "ssl|tls|handshake|526|525|522"
# Что отвечает приложение
journalctl -u plusson-api --since "today" | grep "tg_id=5938389914"
```

### Шаг 5 — глобальный тест доступности

https://check-host.net/check-http?host=https%3A%2F%2Fpluson.ru%2F&max_nodes=30

Показывает из каких точек мира сайт открывается. Бесплатно.

### Шаг 6 — диагностический тест: временно снять Proxy

В DNS у нужной записи кликнуть на оранжевую тучу → станет серой (DNS only). Через 1 минуту юзер пойдёт напрямую на Beget IP без CF вообще.

- **Если откроется** → проблема в CF (что-то фильтрует, см. список выше)
- **Если не откроется** → проблема у клиента (VPN, его сеть, его устройство)

⚠️ После теста **вернуть оранжевую тучу обратно**!

---

## 📊 Лимиты Free плана (на 17.05.2026)

| Что | Лимит | Что делать если упрёмся |
|---|---|---|
| Доменов в аккаунте | Без лимита | — |
| Запросов в сутки | Без лимита | — |
| **Размер загружаемого файла** | **100 MB** | Снять proxy у конкретного endpoint, или прямой R2-upload из браузера |
| WAF custom rules | 5 | Pro ($20/мес) дает 20 |
| Page rules | 3 | Pro дает 20 |
| Image optimization | — | Не на Free (есть на Pro) |
| Bot management | базовая | Pro/Business — продвинутая |

**Когда переходить на Pro:**
- DDoS-атаки (видно по всплеску 5xx в логах)
- Боты-парсеры начнут грабить контент
- Хочется автооптимизации картинок (Polish, Mirage)

---

## 📚 История изменений

- **2026-05-14** — pluson.ru/www/dev подключены к Cloudflare (решение ERR_TIMED_OUT для VPN)
- **2026-05-14** — ivision.margoforbs.ru → ivision.pluson.ru (за CF)
- **2026-05-14** — lever_agent API: nip.io → lever.pluson.ru (за CF)
- **2026-05-17** — **HTTP/3 выключен** (ломал 20% VPN-юзеров). Browser Integrity Check выключен.

---

## 🔗 Связанные файлы

- [`memory/project_cloudflare_setup.md`](../memory/project_cloudflare_setup.md) — короткая справка для AI-памяти
- [`memory/project_ivision_moved_to_pluson_subdomain.md`](../memory/project_ivision_moved_to_pluson_subdomain.md) — переезд iVision
- [`memory/project_lever_api_moved_to_pluson.md`](../memory/project_lever_api_moved_to_pluson.md) — переезд lever API
- [`memory/server_access.md`](../memory/server_access.md) — реквизиты прод-сервера
