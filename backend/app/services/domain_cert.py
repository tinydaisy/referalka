"""
Сертификаты для доменов клиентов + подключение домена к nginx.

Клиент нажимает «Выпустить сертификат» → мы добавляем ему server-блок в
nginx, выпускаем сертификат Let's Encrypt и перезагружаем nginx. Дальше
всё публичное открывается на его домене.

⚠️ ТОЛЬКО RSA (--key-type rsa). ECDSA-сертификат идёт цепочкой к корню
ISRG Root X2, которого нет на Android до 7.1, старых Windows, телевизорах и
в корпоративных сетях с фильтрацией HTTPS — у части людей сайт просто не
открывается, причём вперемешку и без всякой закономерности. Это уже было
на pluson.ru и стоило долгих поисков не там. RSA идёт к ISRG Root X1,
который знают практически все устройства.

⚠️ Флаг --key-type НЕ запоминается в конфиге обновления сам по себе.
При ручном перевыпуске указывать заново, иначе можно молча вернуться на
ECDSA и снова потерять часть аудитории.

⚠️ Требует root (пишет в /etc/nginx, дёргает certbot и systemctl).
Вызывать только из API-процесса — он под root; Celery под www-data не
сможет.
"""
from __future__ import annotations

import logging
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

NGINX_SITES = Path("/etc/nginx/sites-enabled")
# Общий кусок конфига с location-правилами: подключается через include
# в каждый клиентский server-блок, чтобы не копировать 200 строк на домен
# и не забыть обновить их при добавлении нового публичного маршрута.
SHARED_LOCATIONS = Path("/etc/nginx/snippets/plusson-public-locations.conf")

CERT_EMAIL = "margarita.vl2011@gmail.com"


class CertError(Exception):
    """Не удалось выпустить сертификат или подключить домен."""


def _run(cmd: list[str], *, timeout: int = 180) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout, check=False)
        return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()
    except subprocess.TimeoutExpired:
        return 124, f"Команда не уложилась в {timeout} с"
    except FileNotFoundError:
        return 127, f"Команда не найдена: {cmd[0]}"
    except Exception as e:  # pragma: no cover
        return 1, f"{e!r}"


def cert_name_for(domain: str) -> str:
    """Имя сертификата в certbot. Совпадает с доменом — так проще искать руками."""
    return domain.strip().lower()


def _site_path(domain: str) -> Path:
    return NGINX_SITES / f"client-{domain.strip().lower()}"


# ── nginx ───────────────────────────────────────────────────────────────────

def _http_only_config(domain: str) -> str:
    """Временный конфиг на 80-м порту — нужен, чтобы certbot прошёл проверку.

    Сертификата ещё нет, поэтому 443-блок писать нельзя: nginx не стартует
    с ссылкой на несуществующий файл сертификата и уронит ВСЕ сайты.
    """
    return f"""# Домен клиента {domain} — временный конфиг до выпуска сертификата.
# Создаётся автоматически (миграция 270). Руками не править.
server {{
    listen 80;
    server_name {domain};

    location /.well-known/acme-challenge/ {{
        root /var/www/html;
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}
"""


def _full_config(domain: str) -> str:
    """Боевой конфиг: 80 → редирект, 443 с сертификатом и общими location."""
    return f"""# Домен клиента {domain} — публичные страницы ПЛЮСОНа на своём домене.
# Создаётся автоматически (миграция 270). Руками не править:
# при перевыпуске сертификата файл перезаписывается.
server {{
    listen 80;
    server_name {domain};

    location /.well-known/acme-challenge/ {{
        root /var/www/html;
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}

server {{
    listen 443 ssl;
    server_name {domain};

    ssl_certificate     /etc/letsencrypt/live/{domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    include {SHARED_LOCATIONS};
}}
"""


def write_site_config(domain: str, *, with_ssl: bool) -> None:
    domain = domain.strip().lower()
    body = _full_config(domain) if with_ssl else _http_only_config(domain)
    _site_path(domain).write_text(body, encoding="utf-8")


def remove_site_config(domain: str) -> None:
    p = _site_path(domain)
    if p.exists():
        p.unlink()


def nginx_test() -> tuple[bool, str]:
    code, out = _run(["nginx", "-t"], timeout=30)
    return code == 0, out


def nginx_reload() -> tuple[bool, str]:
    ok, out = nginx_test()
    if not ok:
        return False, out
    code, out = _run(["systemctl", "reload", "nginx"], timeout=30)
    return code == 0, out


# ── certbot ─────────────────────────────────────────────────────────────────

_EXPIRY_RE = re.compile(
    r"Certificate Name:\s*(?P<name>\S+).*?Expiry Date:\s*(?P<exp>[0-9-]+\s[0-9:]+\+[0-9:]+)",
    re.S,
)


def cert_expiry(domain: str) -> Optional[datetime]:
    """Когда истекает сертификат домена. None — сертификата нет."""
    name = cert_name_for(domain)
    code, out = _run(["certbot", "certificates", "--cert-name", name], timeout=60)
    if code != 0:
        return None
    m = _EXPIRY_RE.search(out)
    if not m:
        return None
    raw = m.group("exp").strip()
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        try:
            return datetime.strptime(raw.split("+")[0].strip(),
                                     "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            return None


def issue_certificate(domain: str, *, force: bool = False) -> datetime:
    """Выпустить сертификат и подключить домен к nginx. Вернуть дату окончания.

    Порядок важен: сначала временный HTTP-конфиг (иначе certbot не пройдёт
    проверку и nginx упадёт на несуществующем сертификате), потом выпуск,
    потом боевой конфиг с 443.
    """
    domain = domain.strip().lower()
    if not domain:
        raise CertError("Пустой домен")

    name = cert_name_for(domain)

    # 1. Временный конфиг на 80 порту — для ACME-проверки.
    write_site_config(domain, with_ssl=False)
    ok, out = nginx_reload()
    if not ok:
        remove_site_config(domain)
        _run(["systemctl", "reload", "nginx"], timeout=30)
        raise CertError(f"nginx не принял конфиг домена: {out[:400]}")

    # 2. Выпуск. webroot, а не --nginx: плагин nginx правит конфиги сам и может
    #    затронуть основной сайт. Здесь мы управляем конфигами явно.
    cmd = [
        "certbot", "certonly", "--webroot", "-w", "/var/www/html",
        "--cert-name", name,
        "-d", domain,
        "--key-type", "rsa", "--rsa-key-size", "2048",   # ⚠️ только RSA
        "--non-interactive", "--agree-tos",
        "--email", CERT_EMAIL,
        "--no-eff-email",
    ]
    if force:
        cmd.append("--force-renewal")

    code, out = _run(cmd, timeout=300)
    if code != 0:
        # Конфиг оставляем: домен уже ведёт на нас, и 80-й порт с редиректом
        # лучше, чем полное отсутствие ответа. Клиент увидит ошибку в кабинете.
        raise CertError(_humanize_certbot_error(out))

    # 3. Боевой конфиг с 443.
    write_site_config(domain, with_ssl=True)
    ok, out = nginx_reload()
    if not ok:
        raise CertError(f"Сертификат выпущен, но nginx не принял конфиг: {out[:400]}")

    exp = cert_expiry(domain)
    if exp is None:
        raise CertError("Сертификат выпущен, но не удалось прочитать срок действия")
    logger.info("Сертификат для %s выпущен до %s", domain, exp)
    return exp


def revoke_domain(domain: str) -> None:
    """Отключить домен: убрать конфиг nginx и удалить сертификат."""
    domain = domain.strip().lower()
    remove_site_config(domain)
    nginx_reload()
    _run(["certbot", "delete", "--cert-name", cert_name_for(domain),
          "--non-interactive"], timeout=120)


def _humanize_certbot_error(out: str) -> str:
    """Понятный текст вместо простыни от certbot."""
    low = (out or "").lower()
    if "too many failed authorizations" in low or "rate limit" in low:
        return ("Let's Encrypt временно ограничил выпуск для этого домена "
                "(слишком много неудачных попыток). Попробуйте через час — "
                "и убедитесь, что DNS уже настроен")
    if "dns problem" in low or "nxdomain" in low:
        return ("Домен не находится в DNS. Проверьте, что запись CNAME добавлена "
                "и успела обновиться")
    if "connection refused" in low or "timeout" in low or "unauthorized" in low:
        return ("Let's Encrypt не смог достучаться до домена. Обычно это значит, "
                "что DNS ещё не обновился либо домен ведёт не на наш сервер")
    tail = (out or "").strip().splitlines()
    return "Не удалось выпустить сертификат: " + (tail[-1][:300] if tail else "неизвестная ошибка")
