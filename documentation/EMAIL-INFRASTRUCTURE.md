# EMAIL-INFRASTRUCTURE.md — Email-рассылки и собственный mail-сервер

> Полный технический план реализации email-рассылок в ПЛЮСОНе на собственной mail-инфраструктуре.
> **Статус:** не реализовано, отложено. Решения зафиксированы — делать по этому плану когда дойдёт очередь.
> **Дата фиксации:** 2026-05-04
> **Кто решал:** Маргарита + Claude

---

## Оглавление

1. [Цель и архитектурные решения](#1-цель-и-архитектурные-решения)
2. [DNS-записи (что у Reg.ru, что у Beget)](#2-dns-записи)
3. [Установка и настройка mail-сервера](#3-установка-и-настройка-mail-сервера)
4. [Конфиги Postfix](#4-конфиги-postfix)
5. [Конфиги OpenDKIM](#5-конфиги-opendkim)
6. [Миграция БД 053](#6-миграция-бд-053)
7. [Бэкенд — структура кода](#7-бэкенд--структура-кода)
8. [API-эндпоинты](#8-api-эндпоинты)
9. [Структура MIME-сообщения](#9-структура-mime-сообщения)
10. [Frontend (дашборд)](#10-frontend-дашборд)
11. [Прогрев домена](#11-прогрев-домена)
12. [Antispam-чеклист](#12-antispam-чеклист)
13. [Тестирование](#13-тестирование)
14. [Что отложено на потом](#14-что-отложено-на-потом)
15. [Текст тикета в Beget](#15-текст-тикета-в-beget)
16. [Ссылки и инструменты](#16-ссылки-и-инструменты)

---

## 1. Цель и архитектурные решения

### 1.1 Цель

Дать клиентам ПЛЮСОНа возможность слать **email-рассылки по своей базе** (наряду с TG/VK/MAX). Все письма идут через **собственный mail-сервер на VPS Beget**, без сторонних провайдеров (Unisender, SendPulse, Resend и т.п.).

**Почему свой сервер:**
- Beget официально подтвердил в тикете 2026-05-04 — собственный mail-сервер на VPS не имеет лимитов
- Экономия (Unisender от 480 ₽/мес уже на 1K контактов, дальше дороже)
- Полный контроль над доставкой и аналитикой
- Аналог по модели — GetCourse: своя SMTP-инфраструктура, поддомены клиентов вида `ivision-medialift.getcourse.ru`

### 1.2 Архитектурные решения (зафиксированы)

| Решение | Что выбрано |
|---|---|
| Mail-сервер | Postfix + OpenDKIM, на том же VPS что и backend |
| Входящие письма | НЕ принимаем (Dovecot/IMAP не ставим) |
| Где хранятся email-настройки | В `channels`, отдельные nullable-колонки |
| Email-канал создаётся | Явно клиентом, не автоматом при регистрации |
| Поддомен | Клиент сам выбирает (`ivision-medialift`), не генерируется автоматом |
| Адрес отправителя | `{email_from_local}@{email_subdomain}.pluson.ru` |
| Reply-To | Пустой (no-reply) |
| Отписка | Ссылка в подвале письма, JWT-токен, endpoint ставит `is_unsubscribed=TRUE` |
| Версия 1 (MVP email) | Plain-text письма, без HTML-вёрстки |
| Версия 2 | HTML + визуальный редактор + bounce-обработка |
| Кастомные домены клиентов | Pro-тариф, отложено |
| DKIM | Один ключ на `pluson.ru`, через relaxed alignment работает на всех поддоменах |

### 1.3 Что НЕ делаем

- НЕ ставим Dovecot/IMAP/POP3 — входящие не нужны
- НЕ ставим webmail (Roundcube)
- НЕ делаем алиасы и forwarding
- НЕ делаем bounce-handling в MVP (только логируем) — Этап 2
- НЕ делаем HTML-редактор в MVP — Этап 2
- НЕ делаем подключение собственного домена клиента в MVP — Pro-тариф, потом

---

## 2. DNS-записи

### 2.1 На `pluson.ru` (управляется в Reg.ru)

| Тип | Имя | Значение | Цель |
|---|---|---|---|
| A | `mail.pluson.ru` | `194.156.119.17` | Имя нашего mail-сервера на проде |
| A | `mail.dev.pluson.ru` | `62.113.98.30` | Имя mail-сервера на dev |
| A | `*.pluson.ru` | `194.156.119.17` | Wildcard для поддоменов клиентов |
| MX | `pluson.ru` | `10 mail.pluson.ru` | Куда слать почту для домена |
| TXT | `pluson.ru` | `v=spf1 a mx ip4:194.156.119.17 -all` | SPF — кто имеет право слать от имени pluson.ru |
| TXT | `mail._domainkey.pluson.ru` | `v=DKIM1; k=rsa; p=<публичный_ключ>` | DKIM — публичный ключ для проверки подписи |
| TXT | `_dmarc.pluson.ru` | `v=DMARC1; p=none; rua=mailto:dmarc@pluson.ru; pct=100` | DMARC — мягкая политика на старте, ужесточаем потом |

**SPF:** `-all` (жёсткий fail — все левые отправители режутся). Если потом захотим слать ещё через провайдер — меняем на `~all` (soft fail) и добавляем `include:_spf.provider.com`.

**DMARC pct=100** — применять политику ко всем письмам. На старте `p=none` (только репорты, без фактической отбраковки), через 4-6 недель — `p=quarantine`, потом `p=reject`.

### 2.2 На стороне Beget (PTR-записи — открыть тикетом)

| IP | PTR (имя) |
|---|---|
| `62.113.98.30` | `mail.dev.pluson.ru` |
| `194.156.119.17` | `mail.pluson.ru` |

**Почему PTR ставит Beget, а не мы:** обратные DNS-зоны (`30.98.113.62.in-addr.arpa`) принадлежат владельцу IP-блока (хостеру). Клиент VPS не может управлять PTR через панель домена.

**Зачем нужно:** Gmail/Mail.ru/Yandex при получении письма проверяют PTR. Если он пустой или не совпадает с HELO/доменом отправителя — письмо в спам или отказ.

### 2.3 Wildcard-нюанс

Wildcard `*.pluson.ru` НЕ перекрывает явные A-записи. То есть:
- `mail.pluson.ru` → `194.156.119.17` (явная запись, выигрывает)
- `dev.pluson.ru` → `62.113.98.30` (если есть явная)
- `ivision-medialift.pluson.ru` → `194.156.119.17` (через wildcard)

Но wildcard НЕ покрывает поддомены второго уровня. То есть `foo.bar.pluson.ru` НЕ попадёт под `*.pluson.ru`. Нам и не надо — клиентские subdomain'ы только первого уровня.

### 2.4 Проверка DNS после настройки

```bash
# A-запись
dig +short mail.pluson.ru                  # → 194.156.119.17
dig +short ivision-medialift.pluson.ru     # → 194.156.119.17 (wildcard)

# MX
dig +short MX pluson.ru                    # → 10 mail.pluson.ru.

# SPF
dig +short TXT pluson.ru | grep spf

# DKIM
dig +short TXT mail._domainkey.pluson.ru

# DMARC
dig +short TXT _dmarc.pluson.ru

# PTR
dig +short -x 194.156.119.17               # → mail.pluson.ru.
dig +short -x 62.113.98.30                 # → mail.dev.pluson.ru.
```

---

## 3. Установка и настройка mail-сервера

### 3.1 Сначала на dev (62.113.98.30)

```bash
# 1. Hostname
hostnamectl set-hostname mail.dev.pluson.ru
echo "127.0.1.1 mail.dev.pluson.ru mail" >> /etc/hosts

# 2. Postfix + OpenDKIM
DEBIAN_FRONTEND=noninteractive apt-get install -y postfix opendkim opendkim-tools mailutils

# При установке Postfix спросит:
#   - General type of mail configuration → Internet Site
#   - System mail name → mail.dev.pluson.ru

# 3. Backup дефолтных конфигов
cp /etc/postfix/main.cf /etc/postfix/main.cf.bak
cp /etc/opendkim.conf /etc/opendkim.conf.bak

# 4. Применить наши конфиги (см. разделы 4 и 5)

# 5. Сгенерировать DKIM-ключ
mkdir -p /etc/opendkim/keys/pluson.ru
opendkim-genkey -b 2048 -d pluson.ru -D /etc/opendkim/keys/pluson.ru -s mail -v
chown -R opendkim:opendkim /etc/opendkim/keys
chmod 600 /etc/opendkim/keys/pluson.ru/mail.private

# 6. Скопировать публичный ключ — добавить в DNS как TXT mail._domainkey.pluson.ru
cat /etc/opendkim/keys/pluson.ru/mail.txt

# 7. Запустить
systemctl enable opendkim postfix
systemctl restart opendkim postfix

# 8. Проверка
echo "Тестовое письмо" | mail -s "Test from VPS" -a "From: hello@pluson.ru" margarita.vl2011@gmail.com

# 9. Логи
tail -f /var/log/mail.log
```

### 3.2 На прод — после успешной проверки на dev

Тот же процесс, hostname = `mail.pluson.ru`, тот же DKIM-ключ можно переиспользовать (или сгенерировать новый — оба варианта рабочие, но один общий ключ проще).

---

## 4. Конфиги Postfix

### 4.1 `/etc/postfix/main.cf`

```ini
# Базовые настройки
myhostname = mail.pluson.ru
mydomain = pluson.ru
myorigin = $mydomain
mydestination = localhost.$mydomain, localhost
relayhost =

# Слушать только localhost — приложения подключаются с того же сервера
inet_interfaces = loopback-only
inet_protocols = ipv4

# Сети, которым доверяем (могут отправлять без auth)
mynetworks = 127.0.0.0/8 [::1]/128

# Лимит размера письма — 25 MB
message_size_limit = 26214400

# TLS для исходящих соединений (когда шлём в Gmail/Mail.ru)
smtp_tls_security_level = may
smtp_tls_loglevel = 1
smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt
smtp_use_tls = yes

# Не принимаем входящие — slушаем только loopback. Но на всякий случай:
smtpd_tls_security_level = none
smtpd_helo_required = yes
smtp_helo_name = $myhostname

# OpenDKIM milter
milter_default_action = accept
milter_protocol = 6
smtpd_milters = inet:localhost:8891
non_smtpd_milters = inet:localhost:8891

# Очередь — ретраить отвергнутые письма 5 дней
maximal_queue_lifetime = 5d
bounce_queue_lifetime = 5d

# Отправлять с правильным From — приложение полностью контролирует From
# (мы не переопределяем sender_canonical_maps)

# Совместимость
compatibility_level = 3.6
```

### 4.2 `/etc/postfix/master.cf`

Оставляем дефолтным (для отправки только через `sendmail`/SMTP localhost достаточно базового `smtp` сервиса). Если нужен submission-порт 587 — добавляем. Но нам не нужен, всё локально.

### 4.3 Проверка отправки из приложения

```python
# Тест из Python
import smtplib
from email.message import EmailMessage

msg = EmailMessage()
msg["From"] = "ПЛЮСОН <hello@pluson.ru>"
msg["To"] = "margarita.vl2011@gmail.com"
msg["Subject"] = "Тестовое письмо с VPS"
msg.set_content("Привет! Это первое письмо с нашего сервера.")

with smtplib.SMTP("127.0.0.1", 25) as s:
    s.send_message(msg)
```

---

## 5. Конфиги OpenDKIM

### 5.1 `/etc/opendkim.conf`

```ini
# Логирование
Syslog yes
SyslogSuccess yes
LogWhy yes

# Безопасность
UMask 002
UserID opendkim:opendkim

# Подписание
Domain pluson.ru
Selector mail
SignatureAlgorithm rsa-sha256
Canonicalization relaxed/relaxed

# Включаем подпись для всех поддоменов (relaxed alignment)
SubDomains yes

# Режим — только подписываем (s), не верифицируем (v отключён, нам не надо)
Mode s

# Авторестарт
AutoRestart yes
AutoRestartRate 10/1h

# Настройки таблиц
KeyTable /etc/opendkim/KeyTable
SigningTable refile:/etc/opendkim/SigningTable
ExternalIgnoreList refile:/etc/opendkim/TrustedHosts
InternalHosts refile:/etc/opendkim/TrustedHosts

# Сокет для milter (Postfix подключается сюда)
Socket inet:8891@localhost

# Таймауты
DNSTimeout 5
```

### 5.2 `/etc/opendkim/KeyTable`

```
mail._domainkey.pluson.ru pluson.ru:mail:/etc/opendkim/keys/pluson.ru/mail.private
```

### 5.3 `/etc/opendkim/SigningTable`

```
*@pluson.ru mail._domainkey.pluson.ru
*@*.pluson.ru mail._domainkey.pluson.ru
```

Звёздочки = regex. Любой адрес от `pluson.ru` или поддомена `*.pluson.ru` подписывается одним и тем же ключом.

### 5.4 `/etc/opendkim/TrustedHosts`

```
127.0.0.1
::1
localhost
*.pluson.ru
```

### 5.5 `/etc/default/opendkim`

```bash
SOCKET="inet:8891@localhost"
```

### 5.6 Получение публичного DKIM-ключа

После `opendkim-genkey` файл `/etc/opendkim/keys/pluson.ru/mail.txt` выглядит примерно так:

```
mail._domainkey IN TXT ( "v=DKIM1; h=sha256; k=rsa; "
  "p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvHN..."
  "...hbz9OqQIDAQAB" )
```

В Reg.ru добавляем TXT-запись на `mail._domainkey.pluson.ru` со значением — содержимое `p=...` (всё что в кавычках, склеенное в одну строку).

---

## 6. Миграция БД 053

### 6.1 Файл `db/migrations/053_email_channels.sql`

```sql
-- Миграция 053 — Email-каналы и поля для email-рассылок
-- Дата: TBD (когда дойдём)

BEGIN;

-- ================================================================
-- 1. Платформа email
-- ================================================================
INSERT INTO platforms (slug, name, icon_emoji, color_hex, message_max_length, supports_buttons, sort_order)
VALUES ('email', 'Email', '✉️', '#3D8CB6', 100000, false, 4)
ON CONFLICT (slug) DO NOTHING;

-- ================================================================
-- 2. Email-настройки канала
-- ================================================================
ALTER TABLE channels
  ADD COLUMN email_subdomain TEXT,
  ADD COLUMN email_from_local TEXT,
  ADD COLUMN email_from_name TEXT,
  ADD COLUMN email_custom_domain TEXT,
  ADD COLUMN email_custom_domain_verified BOOLEAN DEFAULT FALSE;

-- Уникальность поддомена pluson.ru — глобальная (один subdomain = один канал)
CREATE UNIQUE INDEX channels_email_subdomain_uniq
  ON channels(email_subdomain)
  WHERE email_subdomain IS NOT NULL AND email_custom_domain IS NULL;

-- Уникальность кастомного домена клиента (Pro)
CREATE UNIQUE INDEX channels_email_custom_domain_uniq
  ON channels(email_custom_domain)
  WHERE email_custom_domain IS NOT NULL;

-- Валидация (CHECK-констрейнты)
ALTER TABLE channels ADD CONSTRAINT email_subdomain_format
  CHECK (
    email_subdomain IS NULL
    OR email_subdomain ~ '^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$'
  );

ALTER TABLE channels ADD CONSTRAINT email_from_local_format
  CHECK (
    email_from_local IS NULL
    OR email_from_local ~ '^[a-z0-9.-]+$'
  );

-- Если platform_slug = 'email' → email_subdomain ИЛИ email_custom_domain должны быть заполнены
ALTER TABLE channels ADD CONSTRAINT email_channel_has_address
  CHECK (
    platform_slug != 'email'
    OR email_subdomain IS NOT NULL
    OR email_custom_domain IS NOT NULL
  );

-- ================================================================
-- 3. Поля для email в шаблонах рассылок
-- ================================================================
ALTER TABLE broadcast_templates
  ADD COLUMN subject TEXT,
  ADD COLUMN html_body TEXT;

-- ================================================================
-- 4. Лог отписок (для антифрода и истории)
-- ================================================================
CREATE TABLE email_unsubscribe_log (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  unsubscribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX email_unsubscribe_log_contact_id_idx ON email_unsubscribe_log(contact_id);
CREATE INDEX email_unsubscribe_log_channel_id_idx ON email_unsubscribe_log(channel_id);
CREATE INDEX email_unsubscribe_log_client_id_idx ON email_unsubscribe_log(client_id);

-- ================================================================
-- 5. Лог bounce (Этап 2 — на потом, но место зарезервируем)
-- ================================================================
CREATE TABLE email_bounce_log (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  bounce_type TEXT NOT NULL,  -- 'hard' | 'soft' | 'complaint'
  smtp_code TEXT,
  smtp_message TEXT,
  raw_log TEXT,
  bounced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed BOOLEAN DEFAULT FALSE
);

CREATE INDEX email_bounce_log_to_email_idx ON email_bounce_log(to_email);
CREATE INDEX email_bounce_log_processed_idx ON email_bounce_log(processed) WHERE processed = FALSE;

-- ================================================================
-- 6. Расширение broadcast_log для email
-- ================================================================
-- Колонка `to_address` уже есть и универсальная (хранит tg_id или email).
-- `message_id` (TG message_id или email Message-ID) — тоже уже есть.
-- Добавим только email-специфичный статус для bounce-обработки:
ALTER TABLE broadcast_log
  ADD COLUMN email_bounced BOOLEAN DEFAULT FALSE,
  ADD COLUMN email_bounced_at TIMESTAMP WITH TIME ZONE;

COMMIT;
```

### 6.2 Откат миграции (rollback)

```sql
-- 053_email_channels_rollback.sql

BEGIN;

ALTER TABLE broadcast_log
  DROP COLUMN email_bounced,
  DROP COLUMN email_bounced_at;

DROP TABLE email_bounce_log;
DROP TABLE email_unsubscribe_log;

ALTER TABLE broadcast_templates
  DROP COLUMN subject,
  DROP COLUMN html_body;

ALTER TABLE channels
  DROP CONSTRAINT email_channel_has_address,
  DROP CONSTRAINT email_from_local_format,
  DROP CONSTRAINT email_subdomain_format;

DROP INDEX channels_email_custom_domain_uniq;
DROP INDEX channels_email_subdomain_uniq;

ALTER TABLE channels
  DROP COLUMN email_custom_domain_verified,
  DROP COLUMN email_custom_domain,
  DROP COLUMN email_from_name,
  DROP COLUMN email_from_local,
  DROP COLUMN email_subdomain;

DELETE FROM platforms WHERE slug = 'email';

COMMIT;
```

---

## 7. Бэкенд — структура кода

### 7.1 Новые/изменяемые файлы

```
backend/app/
├── core/
│   └── config.py                    [+] LOCAL_POSTFIX_HOST, UNSUBSCRIBE_SECRET, EMAIL_DEFAULT_FROM_NAME
├── services/
│   ├── email_sender.py              [+] класс EmailSender, отправка через локальный Postfix
│   ├── unsubscribe_token.py         [+] генерация и проверка JWT для отписки
│   ├── message_builder.py           [~] добавить ветку для email (subject + body_text + body_html)
│   └── channels.py                  [~] добавить get_email_send_targets()
├── api/
│   ├── channels.py                  [~] валидация email_* при создании email-канала, check-subdomain
│   └── email_unsubscribe.py         [+] GET /unsubscribe?token=...
└── tasks/
    └── broadcast.py                 [~] ветка для платформы email

db/migrations/
└── 053_email_channels.sql           [+] см. раздел 6
```

### 7.2 `app/core/config.py` — добавить

```python
class Settings(BaseSettings):
    # ... существующее ...

    # Email-инфраструктура
    LOCAL_POSTFIX_HOST: str = "127.0.0.1"
    LOCAL_POSTFIX_PORT: int = 25
    UNSUBSCRIBE_SECRET: str  # из .env, рандомный 32+ байта
    EMAIL_DEFAULT_FROM_NAME: str = "ПЛЮСОН"
    EMAIL_PUBLIC_BASE_URL: str = "https://pluson.ru"  # для unsubscribe ссылок
```

### 7.3 `app/services/unsubscribe_token.py`

```python
import time
import jwt
from app.core.config import settings

ALGORITHM = "HS256"
TOKEN_TTL_DAYS = 365  # ссылки в письмах должны работать долго

def make_unsubscribe_token(client_id: int, contact_id: int, channel_id: int) -> str:
    payload = {
        "cid": client_id,
        "co": contact_id,
        "ch": channel_id,
        "iat": int(time.time()),
    }
    return jwt.encode(payload, settings.UNSUBSCRIBE_SECRET, algorithm=ALGORITHM)


def parse_unsubscribe_token(token: str) -> dict:
    """Бросает jwt.InvalidTokenError при невалидном токене."""
    return jwt.decode(token, settings.UNSUBSCRIBE_SECRET, algorithms=[ALGORITHM])
```

### 7.4 `app/services/email_sender.py`

```python
import smtplib
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from app.core.config import settings
from app.services.unsubscribe_token import make_unsubscribe_token


class EmailSender:
    """
    Отправка через локальный Postfix на 127.0.0.1:25.
    Postfix принимает с loopback без auth (mynetworks=127.0.0.0/8).
    OpenDKIM milter автоматически подписывает все исходящие.
    """

    def __init__(self):
        self.host = settings.LOCAL_POSTFIX_HOST
        self.port = settings.LOCAL_POSTFIX_PORT

    def _build_from_address(self, channel) -> str:
        """ivision-medialift.pluson.ru → hello@ivision-medialift.pluson.ru"""
        if channel.email_custom_domain:
            domain = channel.email_custom_domain
        else:
            domain = f"{channel.email_subdomain}.pluson.ru"
        return f"{channel.email_from_local}@{domain}"

    def _unsubscribe_url(self, client_id: int, contact_id: int, channel_id: int) -> str:
        token = make_unsubscribe_token(client_id, contact_id, channel_id)
        return f"{settings.EMAIL_PUBLIC_BASE_URL}/api/v1/email/unsubscribe?token={token}"

    def _build_message(self, channel, contact, subject: str, body_text: str,
                        body_html: str | None = None) -> EmailMessage:
        msg = EmailMessage()

        from_addr = self._build_from_address(channel)
        from_name = channel.email_from_name or settings.EMAIL_DEFAULT_FROM_NAME

        msg["From"] = f"{from_name} <{from_addr}>"
        msg["To"] = contact.email
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=from_addr.split("@")[1])

        # Unsubscribe-headers (Gmail one-click)
        unsub_url = self._unsubscribe_url(channel.client_id, contact.id, channel.id)
        msg["List-Unsubscribe"] = f"<{unsub_url}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"

        # Тело — текстовая версия + опционально HTML
        text_footer = f"\n\n---\nЕсли вы больше не хотите получать эти письма, отпишитесь: {unsub_url}"
        msg.set_content(body_text + text_footer)

        if body_html:
            html_footer = (
                '<hr style="margin-top:32px;border:none;border-top:1px solid #eee;">'
                '<p style="color:#999;font-size:12px;line-height:1.4;">'
                f'Если вы больше не хотите получать эти письма, '
                f'<a href="{unsub_url}" style="color:#3D8CB6;">отпишитесь</a>.'
                '</p>'
            )
            msg.add_alternative(body_html + html_footer, subtype="html")

        return msg

    def send(self, channel, contact, subject: str, body_text: str,
             body_html: str | None = None) -> str:
        """
        Возвращает Message-ID. Бросает SMTPException при ошибке.
        Не делает retry — это задача Celery/broadcast worker'а.
        """
        msg = self._build_message(channel, contact, subject, body_text, body_html)

        with smtplib.SMTP(self.host, self.port, timeout=30) as smtp:
            smtp.send_message(msg)

        return msg["Message-ID"]
```

### 7.5 `app/services/message_builder.py` — добавить ветку

```python
def build_email_message(template, event, contact, channel) -> tuple[str, str, str | None]:
    """
    Возвращает (subject, body_text, body_html).
    Подставляет переменные {имя}, {ссылка_на_событие} и т.п. — то же что и в TG.
    """
    subject = _render_template(template.subject or "", event=event, contact=contact)
    body_text = _render_template(template.body_text or "", event=event, contact=contact)
    body_html = (
        _render_template(template.html_body, event=event, contact=contact)
        if template.html_body else None
    )
    return subject, body_text, body_html
```

### 7.6 `app/services/channels.py` — добавить

```python
def get_email_send_targets(client_id: int, db) -> list[Channel]:
    """
    Возвращает email-каналы клиента, активные.
    Аналог get_telegram_send_targets для email.
    """
    return db.query(Channel).filter(
        Channel.client_id == client_id,
        Channel.platform_slug == "email",
        Channel.is_active == True,
    ).all()
```

### 7.7 `app/tasks/broadcast.py` — расширить

```python
# Псевдокод — фактический код пишется по аналогии с TG-веткой
@celery_app.task(bind=True, max_retries=3)
def send_broadcast_message(self, broadcast_log_id: int):
    log = db.get(BroadcastLog, broadcast_log_id)
    channel = db.get(Channel, log.channel_id)

    try:
        if channel.platform_slug == "telegram":
            # ... существующая логика ...
            pass
        elif channel.platform_slug == "email":
            template = db.get(BroadcastTemplate, log.template_id)
            contact = db.get(Contact, log.contact_id)
            event = db.get(Event, log.event_id) if log.event_id else None

            subject, body_text, body_html = build_email_message(template, event, contact, channel)
            sender = EmailSender()
            message_id = sender.send(channel, contact, subject, body_text, body_html)

            log.status = "sent"
            log.message_id = message_id
            log.sent_at = datetime.utcnow()
        # ... vk, max ...
    except Exception as e:
        log.status = "failed"
        log.error = str(e)
        raise self.retry(exc=e, countdown=60 * (2 ** self.request.retries))
    finally:
        db.commit()
```

### 7.8 `app/api/email_unsubscribe.py`

```python
from fastapi import APIRouter, Request, Response, HTTPException
from fastapi.responses import HTMLResponse
import jwt
from app.services.unsubscribe_token import parse_unsubscribe_token
from app.db import get_db
from app.models import PlatformUserChannel, Contact, EmailUnsubscribeLog

router = APIRouter()


@router.get("/api/v1/email/unsubscribe", response_class=HTMLResponse)
async def email_unsubscribe(token: str, request: Request, db=Depends(get_db)):
    try:
        payload = parse_unsubscribe_token(token)
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=400, detail="Невалидная ссылка отписки")

    contact_id = payload["co"]
    channel_id = payload["ch"]
    client_id = payload["cid"]

    contact = db.get(Contact, contact_id)
    if not contact or contact.client_id != client_id:
        raise HTTPException(status_code=400, detail="Ссылка устарела")

    # Найти или создать platform_user для email + найти подписку
    pu = db.query(PlatformUser).filter_by(
        contact_id=contact_id,
        platform_slug="email",
    ).first()
    if pu:
        puc = db.query(PlatformUserChannel).filter_by(
            platform_user_id=pu.id,
            channel_id=channel_id,
        ).first()
        if puc and not puc.is_unsubscribed:
            puc.is_unsubscribed = True
            puc.unsubscribed_at = datetime.utcnow()

    # Лог
    log_entry = EmailUnsubscribeLog(
        contact_id=contact_id,
        channel_id=channel_id,
        client_id=client_id,
        ip_address=request.client.host,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    db.add(log_entry)
    db.commit()

    return HTMLResponse(content="""
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="utf-8">
      <title>Вы отписались — ПЛЮСОН</title>
      <style>
        body { font-family: Roboto, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; text-align: center; }
        h1 { color: #25455D; }
        p { color: #666; line-height: 1.5; }
      </style>
    </head>
    <body>
      <h1>Вы отписались</h1>
      <p>Больше вы не будете получать письма от этого отправителя.</p>
      <p>Если передумаете — напишите им напрямую.</p>
    </body>
    </html>
    """)


# Gmail one-click отписка через POST
@router.post("/api/v1/email/unsubscribe")
async def email_unsubscribe_post(token: str, request: Request, db=Depends(get_db)):
    # та же логика, но без HTML-ответа
    ...
    return Response(status_code=204)
```

### 7.9 `.env` — новые переменные

```bash
# .env (на dev и проде)
LOCAL_POSTFIX_HOST=127.0.0.1
LOCAL_POSTFIX_PORT=25
UNSUBSCRIBE_SECRET=<сгенерировать openssl rand -hex 32>
EMAIL_DEFAULT_FROM_NAME=ПЛЮСОН
EMAIL_PUBLIC_BASE_URL=https://pluson.ru  # на dev — https://dev.pluson.ru
```

---

## 8. API-эндпоинты

### 8.1 Подключение email-канала

**`POST /api/v1/channels`**

Запрос:
```json
{
  "platform_slug": "email",
  "display_name": "Email-рассылки iVision",
  "is_active": true,
  "email_subdomain": "ivision-medialift",
  "email_from_local": "hello",
  "email_from_name": "iVision Конференция"
}
```

Валидация:
- `platform_slug` обязателен, `email`
- `email_subdomain` — `^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$`, длина 3-30
- `email_from_local` — `^[a-z0-9.-]+$`, обычно `hello` или `noreply`
- `email_from_name` — любой UTF-8, длина 1-100
- subdomain должен быть свободен → `409 Conflict`

Ответ 201:
```json
{
  "id": 42,
  "client_id": 1,
  "platform_slug": "email",
  "display_name": "Email-рассылки iVision",
  "is_active": true,
  "email_subdomain": "ivision-medialift",
  "email_from_local": "hello",
  "email_from_name": "iVision Конференция",
  "email_from_address": "hello@ivision-medialift.pluson.ru",
  "created_at": "2026-05-04T12:00:00Z"
}
```

### 8.2 Проверка доступности subdomain

**`GET /api/v1/channels/email/check-subdomain?value=ivision-medialift`**

Используется фронтом при вводе subdomain (с дебаунсом 500мс).

Ответ:
```json
{ "available": true }
```
или
```json
{
  "available": false,
  "reason": "Этот поддомен уже занят. Попробуйте другой."
}
```

### 8.3 Отписка

**`GET /api/v1/email/unsubscribe?token=<JWT>`** — HTML-страница «Вы отписались»

**`POST /api/v1/email/unsubscribe?token=<JWT>`** — для Gmail one-click, ответ 204

### 8.4 Изменение и удаление email-канала

**`PATCH /api/v1/channels/{id}`** — изменить `email_from_name`, `is_active`, `display_name`. Менять `email_subdomain` после создания **запрещено** (письма уже разосланы с этим адресом, сломаем отписки).

**`DELETE /api/v1/channels/{id}`** — удаление с подтверждением (модалка с вводом «ПОДТВЕРДИТЬ»). Subdomain после удаления не возвращается в пул — резервируем за client_id навсегда (чтобы не было коллизий с уже разосланными письмами).

---

## 9. Структура MIME-сообщения

### 9.1 Plain-text (MVP версия)

```
From: iVision Конференция <hello@ivision-medialift.pluson.ru>
To: user@gmail.com
Subject: Завтра встречаемся!
Date: Mon, 04 May 2026 12:00:00 +0300
Message-ID: <unique-id@ivision-medialift.pluson.ru>
List-Unsubscribe: <https://pluson.ru/api/v1/email/unsubscribe?token=eyJ...>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 8bit
DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=pluson.ru;
                s=mail; t=...; bh=...; h=From:To:Subject:Date;
                b=...

Привет, Маргарита!

Завтра в 11:00 МСК начинаем конференцию...

---
Если вы больше не хотите получать эти письма, отпишитесь:
https://pluson.ru/api/v1/email/unsubscribe?token=eyJ...
```

### 9.2 Plain-text + HTML (Этап 2)

```
Content-Type: multipart/alternative; boundary="...."

--....
Content-Type: text/plain; charset=utf-8

[plain-text версия]

--....
Content-Type: text/html; charset=utf-8

<!DOCTYPE html>
<html>
<body style="font-family: Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
  ...
  <hr>
  <p style="color:#999;font-size:12px;">
    <a href="https://pluson.ru/api/v1/email/unsubscribe?token=...">Отписаться</a>
  </p>
</body>
</html>

--....--
```

### 9.3 Критичные заголовки

| Заголовок | Зачем |
|---|---|
| `From` | Кто отправил. Должен совпадать с DKIM `d=` (через relaxed alignment) |
| `To` | Получатель. Один! Никаких массовых To/Cc/Bcc |
| `Subject` | UTF-8, при необходимости MIME-encoded |
| `Date` | RFC 5322 формат (`formatdate(localtime=True)`) |
| `Message-ID` | Уникальный, с доменом отправителя |
| `MIME-Version: 1.0` | Обязательно |
| `Content-Type` | `text/plain; charset=utf-8` или `multipart/alternative` |
| `List-Unsubscribe` | Обязателен для Gmail (one-click) |
| `List-Unsubscribe-Post` | `List-Unsubscribe=One-Click` для one-click |
| `Reply-To` | Не ставим — пустой Reply-To = "не отвечайте" |
| `DKIM-Signature` | Добавляется автоматически OpenDKIM milter'ом |

---

## 10. Frontend (дашборд)

### 10.1 `/dashboard/channels` — кнопка «+ Подключить email»

В сайдбаре «КАНАЛЫ» уже есть кнопка `+ Подключить Telegram-бота`. Добавляем рядом `+ Подключить email`.

### 10.2 Модалка подключения email-канала

**Шаги:**

**Шаг 1 — настройки:**
- Поле «Поддомен» (`email_subdomain`) — с проверкой уникальности по дебаунсу 500мс
- Под ним предпросмотр финального домена: `ivision-medialift.pluson.ru`
- Поле «Адрес отправителя» (`email_from_local`) — дефолт `hello`
- Поле «Имя отправителя» (`email_from_name`) — дефолт `ПЛЮСОН`
- Под ними финальный предпросмотр: `iVision Конференция <hello@ivision-medialift.pluson.ru>`

**Шаг 2 — подтверждение:**
- Чек-лист «Я понимаю, что:»
  - Этот поддомен будет закреплён за моим аккаунтом навсегда
  - Письма пойдут с адреса `hello@ivision-medialift.pluson.ru`
  - В каждом письме будет ссылка отписки (по требованию закона)
- Кнопка «Подключить»

**Шаг 3 — успех:**
- «Email-канал подключён! Теперь можете создавать рассылки»
- Кнопка «Открыть рассылки»

### 10.3 Создание рассылки — выбор канала

В UI создания рассылки в карточке мероприятия — **переключатель платформы**:
- Telegram
- Email

При выборе Email:
- Появляются поля «Тема письма» (обязательно) и «Текст письма» (обязательно)
- HTML-версия (Этап 2) — отдельная кнопка «Добавить HTML»
- Превью — показать как выглядит подвал с unsubscribe

### 10.4 Список email-каналов

**Карточка email-канала** в списке `/dashboard/channels`:
```
┌─────────────────────────────────────┐
│ ✉️  Email-рассылки iVision           │
│ hello@ivision-medialift.pluson.ru   │
│ Главный · Активен                    │
│                                      │
│ [Изменить] [Удалить]                 │
└─────────────────────────────────────┘
```

---

## 11. Прогрев домена

**Без прогрева** — Gmail/Mail.ru/Yandex автоматически режут новых отправителей. Нужно постепенно наращивать объём, чтобы накопить репутацию.

### 11.1 График прогрева

| Неделя | Писем/день | Получатели | Цель |
|---|---|---|---|
| 1 | 50 | свои тестовые ящики (Gmail, Mail.ru, Yandex Маргариты) | проверить технику доставки |
| 2 | 200 | топ-100 самых лояльных подписчиков | получить open rate ≥ 40% |
| 3 | 500 | 500 активных | проверить bounce rate < 2% |
| 4 | 1000 | 1000 активных | накопить репутацию |
| 5 | 2000 | 2000 | масштабирование |
| 6+ | 5000-10000 | вся база | стабильно |

### 11.2 Правила прогрева

- Слать **только тем, кто реально подписан** (никаких холодных рассылок!)
- Open rate должен быть ≥ 20-30% (если ниже — слать только самым активным)
- Bounce rate < 5% (если выше — чистить базу от мёртвых адресов)
- Spam complaints < 0.1% (если выше — пересмотреть контент и опт-ин)
- Не делать резких скачков объёма (только постепенный рост)

### 11.3 Мониторинг

- **Postmaster Tools от Gmail**: https://postmaster.google.com — добавить домен `pluson.ru`, дождаться верификации (TXT-запись), смотреть spam rate, IP/domain reputation
- **Postmaster Tools от Mail.ru**: https://postmaster.mail.ru — добавить домен, смотреть статистику доставки
- **Yandex Postoffice**: https://postoffice.yandex.ru — статистика по Yandex-получателям
- **mail-tester.com** — после каждого этапа прогрева, цель ≥ 9/10

---

## 12. Antispam-чеклист

**Технический:**
- ✅ DNS: SPF (`-all`), DKIM (2048 бит), DMARC (`p=none` → `quarantine` → `reject`), MX, PTR
- ✅ Postfix: `inet_interfaces=loopback-only`, `mynetworks=127.0.0.0/8` — закрыто как open relay
- ✅ DKIM-signature на каждом письме (через OpenDKIM milter)
- ✅ TLS на исходящих (`smtp_tls_security_level=may`)
- ✅ HELO/EHLO совпадает с PTR
- ✅ Hostname сервера совпадает с PTR

**Контент:**
- ✅ Subject не содержит спам-триггеры (БЕСПЛАТНО, СРОЧНО, КЛИК ПРЯМО СЕЙЧАС, $$$)
- ✅ Subject не в КАПС-ЛОКЕ
- ✅ Не больше 1-2 emoji в subject
- ✅ Соотношение текст:картинки разумное (не одна большая картинка)
- ✅ Все ссылки на свой домен (не подменены через сокращалки)
- ✅ Подвал с физическим адресом + ссылкой отписки

**Поведенческий:**
- ✅ Только подписавшиеся получатели (double opt-in желательно)
- ✅ Ссылка отписки в каждом письме (закон + рекомендация)
- ✅ List-Unsubscribe header для Gmail one-click
- ✅ Не покупаем базы и не парсим интернет
- ✅ Удаляем bounce-адреса автоматически (Этап 2)
- ✅ Удаляем «спящих» (не открывали 6+ месяцев) — чистка раз в полгода

---

## 13. Тестирование

### 13.1 Перед запуском

```bash
# 1. Конфиг Postfix валиден
postconf -n
postfix check

# 2. OpenDKIM запущен
systemctl status opendkim
opendkim-testkey -d pluson.ru -s mail -vvv

# 3. DNS виден отовсюду
dig +short TXT mail._domainkey.pluson.ru @8.8.8.8
dig +short TXT _dmarc.pluson.ru @8.8.8.8
dig +short -x 194.156.119.17 @8.8.8.8  # PTR должен показать mail.pluson.ru

# 4. Тест отправки
echo "Test" | mail -s "DKIM Test" -a "From: hello@pluson.ru" margarita.vl2011@gmail.com
# В Gmail: открыть письмо → Show original → проверить SPF=PASS, DKIM=PASS, DMARC=PASS

# 5. mail-tester.com
# Открыть https://www.mail-tester.com → получить адрес test-XXX@srv1.mail-tester.com
echo "Test" | mail -s "mail-tester" -a "From: hello@pluson.ru" test-XXX@srv1.mail-tester.com
# Дождаться оценки на сайте — должно быть ≥ 8/10
```

### 13.2 После каждого изменения

- Тест отправки в Gmail, Mail.ru, Yandex, Outlook
- Проверка `Show original` — все три проверки PASS
- mail-tester.com ≥ 8/10
- Логи Postfix без ошибок: `tail -100 /var/log/mail.log | grep -i error`

### 13.3 Внешние инструменты

- https://www.mail-tester.com — общий тест на всё (DNS + контент)
- https://mxtoolbox.com — DNS-проверки SPF/DKIM/DMARC/MX/PTR/blacklist
- https://dmarcian.com/dmarc-inspector/ — анализ DMARC-политики
- https://dkimcore.org/c/keycheck — проверка DKIM-ключа
- https://www.dnsbl.info — проверка IP в blacklist'ах

---

## 14. Что отложено на потом

### Этап 2 (после стабилизации MVP email)

- [ ] HTML-вёрстка писем + визуальный редактор в дашборде
- [ ] Bounce-обработка: парсинг логов Postfix, автоматическое снятие подписки на hard-bounce
- [ ] Аналитика: open rate (трекинг-пиксель), click rate (replace ссылок на трекеры)
- [ ] Подписочный double opt-in (подтверждение email при регистрации)
- [ ] Ужесточение DMARC: `p=none` → `quarantine` → `reject`

### Этап 3 (Pro-тариф)

- [ ] Подключение собственного домена клиента (`mail.ivision.ru`)
- [ ] Wizard: добавить DNS-записи у регистратора → проверка верификации → сгенерировать DKIM-ключ → ставить в Postfix `KeyTable`/`SigningTable`
- [ ] Сегментация рассылок (отправлять не всей базе, а сегменту по тегам)
- [ ] A/B-тесты subject

### Не делаем никогда (вне scope)

- Входящая почта (Dovecot, IMAP, POP3)
- Webmail (Roundcube)
- Алиасы и forwarding
- Парсинг ответов на рассылку в карточку контакта (если нужно — лучше через отдельного провайдера типа Mailgun)

---

## 15. Текст тикета в Beget

**Куда:** https://cp.beget.com/support → «Создать тикет»
**Тип:** «Технический вопрос» / «Настройка сервера»
**Тема:** Настройка PTR-записей для VPS

**Текст:**
> Здравствуйте!
>
> У меня два VPS, на которых планирую поднять собственный почтовый сервер для отправки транзакционных и маркетинговых писем (Postfix + DKIM, рассылки только своим подписчикам с подтверждённым согласием).
>
> Прошу настроить PTR-записи (reverse DNS):
>
> - **62.113.98.30 → mail.dev.pluson.ru**
> - **194.156.119.17 → mail.pluson.ru**
>
> Прямые A-записи на эти поддомены я настрою у регистратора домена самостоятельно.
>
> Спасибо!

**Когда они ответят** — проверить:
```bash
dig +short -x 62.113.98.30      # → mail.dev.pluson.ru.
dig +short -x 194.156.119.17    # → mail.pluson.ru.
```

---

## 16. Ссылки и инструменты

### Документация Beget
- Управление почтой: https://beget.com/ru/kb/manual/pochta
- SMTP/IMAP клиенты: https://beget.com/ru/kb/how-to/mail/obshhie-svedeniya
- Правила хостинга: https://beget.com/ru/pravila

### Документация по Postfix и OpenDKIM
- Postfix configuration: http://www.postfix.org/postconf.5.html
- OpenDKIM: http://opendkim.org/opendkim.conf.5.html
- Digital Ocean гайд: https://www.digitalocean.com/community/tutorials/how-to-configure-postfix-as-a-send-only-smtp-server-on-ubuntu-22-04

### Тестирование и мониторинг
- mail-tester.com — общий тест: https://www.mail-tester.com
- MXToolbox — DNS-проверки: https://mxtoolbox.com
- Gmail Postmaster: https://postmaster.google.com
- Mail.ru Postmaster: https://postmaster.mail.ru
- Yandex Postoffice: https://postoffice.yandex.ru
- DMARC Inspector: https://dmarcian.com/dmarc-inspector/

### Стандарты (RFC)
- SMTP: RFC 5321
- Mail format: RFC 5322
- SPF: RFC 7208
- DKIM: RFC 6376
- DMARC: RFC 7489
- List-Unsubscribe: RFC 2369 + RFC 8058 (one-click)

---

## Приложение A. Состояние на момент фиксации плана (2026-05-04)

**Уже проверено:**
- [x] Порт 25 на dev-сервере (62.113.98.30) **открыт исходящим** — оба внешних SMTP отвечают `220 ESMTP`. Тикет в Beget на разблокировку 25-го порта **не нужен**
- [x] PTR-запись на dev — **не настроена** (`NXDOMAIN`). Нужен тикет в Beget
- [x] Hostname на dev — `myofburqeq.local`. Нужно поменять на `mail.dev.pluson.ru`
- [x] Postfix/OpenDKIM/Dovecot **не установлены** — чистая система

**Открытые вопросы (не решены, нужны до старта реализации):**
- [ ] HTML или plain-text в первой версии — обсуждалось, склоняемся к plain-text для MVP
- [ ] Wildcard DNS на `pluson.ru` — настраивает пользователь у Reg.ru или нужна инструкция по шагам
- [ ] Тикет в Beget на PTR — текст готов в разделе 15, открыть пользователю через `cp.beget.com`

**Что делать когда вернёмся к этой задаче:**
1. Открыть тикет в Beget на PTR (раздел 15)
2. Параллельно — настроить wildcard и mail.* A-записи у Reg.ru
3. Параллельно — установить Postfix+OpenDKIM на dev (раздел 3)
4. Дождаться PTR от Beget (1-2 дня обычно)
5. Применить миграцию 053 (раздел 6)
6. Реализовать бэкенд (раздел 7)
7. Реализовать фронт (раздел 10)
8. Прогрев на dev → проверка → деплой на прод
9. Прогрев на проде по графику (раздел 11)
