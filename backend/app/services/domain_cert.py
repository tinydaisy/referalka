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
import os
import re
import subprocess
import tempfile
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


def _run(cmd: list[str], *, timeout: int = 180,
         stdin_null: bool = False) -> tuple[int, str]:
    """stdin_null=True нужен openssl s_client — без закрытого stdin он висит,
    ожидая ввода, и упирается в таймаут."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout, check=False,
                           stdin=subprocess.DEVNULL if stdin_null else None)
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


def www_alias(domain: str) -> str:
    """`www.<домен>`, если его вообще имеет смысл обслуживать. Иначе пусто.

    ⚠️⚠️ ЗАЧЕМ (2026-08-28). Домен выдавался БЕЗ `www`: и в `server_name`, и в
    сертификате стояло только голое имя. У человека, набравшего привычное
    `www.сайт.ру`, запрос попадал в дефолтный server-блок с сертификатом
    pluson.ru — браузер показывал «подключение не защищено» и дальше не пускал.
    Поймано на живом клиенте (peregovorka.online): DNS у `www` вёл на нас,
    люди по нему заходили, и для них сайт был сломан.

    ⚠️ Проверяем DNS, а НЕ добавляем `www` вслепую: если записи нет, ACME не
    сможет подтвердить это имя и **завалит выпуск целиком** — клиент остался
    бы вообще без сертификата. Нет записи → работаем как раньше, по одному имени.

    ⚠️ Только для КОРНЯ домена. У поддомена (`lp.example.ru`) `www.lp.example.ru`
    никто не набирает, а лишнее имя — лишний шанс провалить выпуск.
    """
    from app.services.client_domains import is_apex_domain, normalize_domain

    d = normalize_domain(domain)
    if not d or d.startswith("www.") or not is_apex_domain(d):
        return ""

    from app.services.domain_dns import _query_sync

    name = f"www.{d}"
    # A-запись на нас либо CNAME куда угодно — во втором случае имя всё равно
    # приезжает к нам (иначе бы клиент его не заводил), проверять цепочку
    # целиком не нужно: ошибётся — ACME просто не подтвердит имя, и мы
    # выпустим сертификат без него (см. фолбэк в issue_certificate).
    if _query_sync(name, "A") or _query_sync(name, "CNAME"):
        return name
    return ""


# ── nginx ───────────────────────────────────────────────────────────────────

def _server_names(domain: str, with_www: Optional[bool]) -> str:
    """Строка для `server_name`. `with_www=None` — решить по DNS.

    ⚠️ На 443 имя `www` можно указывать ТОЛЬКО если оно есть в сертификате.
    Иначе браузер, пришедший на `www`, получит сертификат на другое имя и
    покажет «подключение не защищено» — то есть станет хуже, чем было.
    Поэтому после выпуска сюда приходит явный флаг, а не догадка по DNS.
    """
    if with_www is None:
        with_www = bool(www_alias(domain))
    return f"{domain} www.{domain}" if with_www else domain


def _http_only_config(domain: str, with_www: Optional[bool] = None) -> str:
    """Временный конфиг на 80-м порту — нужен, чтобы certbot прошёл проверку.

    Сертификата ещё нет, поэтому 443-блок писать нельзя: nginx не стартует
    с ссылкой на несуществующий файл сертификата и уронит ВСЕ сайты.
    """
    names = _server_names(domain, with_www)
    return f"""# Домен клиента {domain} — временный конфиг до выпуска сертификата.
# Создаётся автоматически (миграция 270). Руками не править.
server {{
    listen 80;
    server_name {names};

    location /.well-known/acme-challenge/ {{
        root /var/www/html;
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}
"""


def _full_config(domain: str, cert_path: str = "", key_path: str = "",
                 with_www: Optional[bool] = None) -> str:
    """Боевой конфиг: 80 → редирект, 443 с сертификатом и общими location.

    Пути к сертификату зависят от источника: Let's Encrypt и ZeroSSL пишут
    в свои каталоги, загруженный клиентом лежит в UPLOADED_DIR.
    """
    cert_path = cert_path or f"/etc/letsencrypt/live/{domain}/fullchain.pem"
    key_path = key_path or f"/etc/letsencrypt/live/{domain}/privkey.pem"
    names = _server_names(domain, with_www)
    return f"""# Домен клиента {domain} — публичные страницы ПЛЮСОНа на своём домене.
# Создаётся автоматически (миграция 270). Руками не править:
# при перевыпуске сертификата файл перезаписывается.
server {{
    listen 80;
    server_name {names};

    location /.well-known/acme-challenge/ {{
        root /var/www/html;
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}

server {{
    # ⚠️ http2 обязателен: без него браузер открывает до 6 отдельных
    # TLS-соединений на страницу, и на мобильном канале часть не
    # устанавливается — сайт «висит и грузится без стилей».
    listen 443 ssl http2;
    server_name {names};

    ssl_certificate     {cert_path};
    ssl_certificate_key {key_path};
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    include /etc/nginx/snippets/plusson-ssl-extra.conf;

    include {SHARED_LOCATIONS};
}}
"""


def write_site_config(domain: str, *, with_ssl: bool,
                      cert_path: str = "", key_path: str = "",
                      with_www: Optional[bool] = None) -> None:
    """`with_www=None` — решить по DNS; после выпуска передавать ЯВНО, по факту
    того, попал ли `www` в сертификат (см. `_server_names`)."""
    domain = domain.strip().lower()
    body = (_full_config(domain, cert_path, key_path, with_www) if with_ssl
            else _http_only_config(domain, with_www))
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


def _file_expiry(path) -> Optional[datetime]:
    """Срок действия сертификата из файла на диске."""
    code, out = _run(["openssl", "x509", "-in", str(path), "-noout", "-enddate"],
                     timeout=30)
    if code != 0:
        return None
    m = re.search(r"notAfter=(.+)", out)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1).strip(), "%b %d %H:%M:%S %Y %Z").replace(
            tzinfo=timezone.utc)
    except Exception:
        return None


ACME_SH = "/root/.acme.sh/acme.sh"
ZEROSSL_DIR = Path("/root/.acme.sh")


def zerossl_available(domain: str) -> bool:
    """Можно ли выпустить сертификат ZeroSSL для этого домена.

    ⚠️ ZeroSSL (Sectigo) НЕ выдаёт сертификаты на зону .ru — отвечает
    rejectedIdentifier «DNS identifier is disallowed». Проверено на четырёх
    доменах; .online при этом выпускается за минуту. Это блокировка по зоне,
    а не ошибка настройки, поэтому для .ru карточку даже не показываем.
    """
    d = domain.strip().lower()
    if d.endswith(".ru") or d.endswith(".su") or d.endswith(".рф"):
        return False
    return Path(ACME_SH).exists()


def cert_sources_for(domain: str) -> list[str]:
    """Какие способы получить сертификат доступны этому домену."""
    out = ["letsencrypt"]
    if zerossl_available(domain):
        out.append("zerossl")
    out.append("upload")
    return out


def _issue_zerossl(domain: str, force: bool) -> None:
    """Выпуск через ZeroSSL (acme.sh). Корень Sectigo USERTrust — старый,
    известен и старым устройствам, в отличие от нового корня Let's Encrypt."""
    cmd = [ACME_SH, "--home", str(ZEROSSL_DIR), "--issue", "-d", domain]
    if w := www_alias(domain):
        cmd += ["-d", w]
    cmd += ["-w", "/var/www/html", "--server", "zerossl", "--keylength", "2048"]
    if force:
        cmd.append("--force")
    code, out = _run(cmd, timeout=300)
    if code != 0 and "Cert success" not in out:
        if "disallowed" in out:
            raise CertError(
                "ZeroSSL не выдаёт сертификаты для этой доменной зоны. "
                "Выберите другой способ.")
        raise CertError(f"ZeroSSL не выпустил сертификат: {out[-300:]}")


def zerossl_paths(domain: str) -> tuple[Path, Path]:
    d = ZEROSSL_DIR / domain.strip().lower()
    return d / "fullchain.cer", d / f"{domain.strip().lower()}.key"


def issue_certificate(domain: str, *, force: bool = False,
                      source: str = "letsencrypt") -> datetime:
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
    # ⚠️ `--expand` обязателен: без него certbot, встретив уже существующий
    # сертификат на одно имя, молча оставит старый и `www` в него не попадёт.
    www = www_alias(domain)

    def _certbot_cmd(names: list[str]) -> list[str]:
        args = [
            "certbot", "certonly", "--webroot", "-w", "/var/www/html",
            "--cert-name", name,
        ]
        for n in names:
            args += ["-d", n]
        args += [
            "--expand",
            "--key-type", "rsa", "--rsa-key-size", "2048",   # ⚠️ только RSA
            "--non-interactive", "--agree-tos",
            "--email", CERT_EMAIL,
            "--no-eff-email",
        ]
        if force:
            args.append("--force-renewal")
        return args

    cmd = _certbot_cmd([domain] + ([www] if www else []))

    if source == "zerossl":
        if not zerossl_available(domain):
            raise CertError(
                "ZeroSSL не выдаёт сертификаты для этой доменной зоны. "
                "Выберите другой способ.")
        _issue_zerossl(domain, force)
        cert_path, key_path = zerossl_paths(domain)
    else:
        code, out = _run(cmd, timeout=300)
        if code != 0 and www:
            # ⚠️ ВТОРАЯ ПОПЫТКА БЕЗ www. Запись у `www` есть, но подтвердить её
            # не удалось (ведёт не на нас, отдаёт таймаут, застрял старый CNAME).
            # Ронять из-за неё выпуск нельзя: без сертификата не работает ВЕСЬ
            # домен клиента, а без `www` — только привычка набирать его руками.
            logger.warning("cert %s: не подтвердился %s, пробую без него", domain, www)
            www = ""          # в server_name его теперь класть нельзя
            code, out = _run(_certbot_cmd([domain]), timeout=300)
        if code != 0:
            # Конфиг оставляем: домен уже ведёт на нас, и 80-й порт с редиректом
            # лучше, чем полное отсутствие ответа. Клиент увидит ошибку в кабинете.
            raise CertError(_humanize_certbot_error(out))
        cert_path = Path(f"/etc/letsencrypt/live/{domain}/fullchain.pem")
        key_path = Path(f"/etc/letsencrypt/live/{domain}/privkey.pem")

    # 3. Боевой конфиг с 443. `www` в server_name — только если он реально попал
    #    в сертификат: иначе браузер на www получит чужое имя и откажется идти.
    write_site_config(domain, with_ssl=True,
                      cert_path=str(cert_path), key_path=str(key_path),
                      with_www=bool(www))
    ok, out = nginx_reload()
    if not ok:
        raise CertError(f"Сертификат выпущен, но nginx не принял конфиг: {out[:400]}")

    exp = cert_expiry(domain) if source != "zerossl" else _file_expiry(cert_path)
    if exp is None:
        raise CertError("Сертификат выпущен, но не удалось прочитать срок действия")
    logger.info("Сертификат для %s выпущен до %s", domain, exp)
    return exp


# ── загруженный клиентом сертификат ─────────────────────────────────────────
UPLOADED_DIR = Path("/etc/ssl/plusson-uploaded")


def uploaded_paths(domain: str) -> tuple[Path, Path]:
    """Пути к загруженному клиентом сертификату и ключу."""
    d = UPLOADED_DIR / domain.strip().lower()
    return d / "fullchain.pem", d / "privkey.pem"


def _pem_blocks(text: str, kind: str) -> list[str]:
    """Вырезать из текста все блоки нужного типа. Клиент вставляет как есть —
    с пояснениями, лишними переводами строк и подписью письма."""
    pat = re.compile(
        rf"-----BEGIN [A-Z ]*{kind}-----.*?-----END [A-Z ]*{kind}-----",
        re.S)
    return pat.findall(text or "")


def validate_uploaded_cert(domain: str, cert_text: str, key_text: str) -> dict:
    """Проверить загруженный сертификат ДО установки.

    ⚠️ Проверяем всё до записи в nginx: неверная пара «сертификат+ключ»
    роняет nginx целиком, а вместе с ним ВСЕ сайты на сервере.
    Возвращает {ok, error, issuer, expires_at, domains}.
    """
    domain = domain.strip().lower()

    certs = _pem_blocks(cert_text, "CERTIFICATE")
    if not certs:
        return {"ok": False, "error":
                "Не нашли сертификат. Нужен текст, начинающийся с "
                "-----BEGIN CERTIFICATE-----"}
    keys = _pem_blocks(key_text, "PRIVATE KEY")
    if not keys:
        return {"ok": False, "error":
                "Не нашли приватный ключ. Нужен текст, начинающийся с "
                "-----BEGIN PRIVATE KEY----- или -----BEGIN RSA PRIVATE KEY-----"}

    with tempfile.TemporaryDirectory() as tmp:
        cp = Path(tmp) / "c.pem"
        kp = Path(tmp) / "k.pem"
        cp.write_text("\n".join(certs) + "\n", encoding="utf-8")
        kp.write_text(keys[0] + "\n", encoding="utf-8")

        leaf = Path(tmp) / "leaf.pem"
        leaf.write_text(certs[0] + "\n", encoding="utf-8")

        # 1) сертификат вообще читается
        code, out = _run(["openssl", "x509", "-in", str(leaf), "-noout",
                          "-subject", "-issuer", "-enddate"], timeout=30)
        if code != 0:
            return {"ok": False, "error": "Файл сертификата повреждён или это не сертификат"}
        info = out

        # 2) ключ читается и ПОДХОДИТ к сертификату
        c1, m_cert = _run(["openssl", "x509", "-in", str(leaf), "-noout", "-modulus"], timeout=30)
        c2, m_key = _run(["openssl", "rsa", "-in", str(kp), "-noout", "-modulus"], timeout=30)
        if c2 != 0:
            return {"ok": False, "error": "Приватный ключ повреждён или защищён паролем"}
        if c1 != 0 or m_cert.strip() != m_key.strip():
            return {"ok": False, "error":
                    "Приватный ключ не подходит к сертификату — это ключ от другого "
                    "сертификата. Возьмите оба файла из одного заказа."}

        # 3) сертификат выписан на ЭТОТ домен
        _, txt = _run(["openssl", "x509", "-in", str(leaf), "-noout", "-text"], timeout=30)
        names = set(re.findall(r"DNS:([^\s,]+)", txt))
        cn = re.search(r"Subject:.*?CN\s*=\s*([^\s,/]+)", txt)
        if cn:
            names.add(cn.group(1))
        if not _covers_domain(names, domain):
            got = ", ".join(sorted(names)[:5]) or "—"
            return {"ok": False, "error":
                    f"Сертификат выписан на другой домен ({got}), а не на {domain}"}

        # 4) срок не истёк
        code, _ = _run(["openssl", "x509", "-in", str(leaf), "-noout", "-checkend", "0"], timeout=30)
        if code != 0:
            return {"ok": False, "error": "Срок действия сертификата уже истёк"}

    issuer = re.search(r"issuer=.*?CN\s*=\s*([^\n/]+)", info)
    exp = re.search(r"notAfter=(.+)", info)
    expires_at = None
    if exp:
        try:
            expires_at = datetime.strptime(exp.group(1).strip(),
                                           "%b %d %H:%M:%S %Y %Z")
        except Exception:
            pass
    return {"ok": True, "error": None,
            "issuer": (issuer.group(1).strip() if issuer else "—"),
            "expires_at": expires_at,
            "domains": sorted(names)}


def _covers_domain(names: set[str], domain: str) -> bool:
    """Покрывает ли сертификат домен (с учётом wildcard *.example.ru)."""
    for n in names:
        n = n.strip().lower()
        if n == domain:
            return True
        if n.startswith("*.") and domain.endswith(n[1:]) and \
                domain.count(".") == n.count("."):
            return True
    return False


def install_uploaded_cert(domain: str, cert_text: str, key_text: str) -> dict:
    """Проверить и установить загруженный клиентом сертификат.

    ⚠️ Сначала полная проверка (validate_uploaded_cert), только потом запись:
    неверная пара кладёт nginx и уносит ВСЕ сайты сервера.
    ⚠️ При неудачном reload откатываемся на прежний конфиг — иначе домен
    остаётся без сайта.
    """
    domain = domain.strip().lower()
    res = validate_uploaded_cert(domain, cert_text, key_text)
    if not res["ok"]:
        raise CertError(res["error"])

    certs = _pem_blocks(cert_text, "CERTIFICATE")
    keys = _pem_blocks(key_text, "PRIVATE KEY")

    cert_path, key_path = uploaded_paths(domain)
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(cert_path.parent, 0o700)

    prev = _site_path(domain).read_text(encoding="utf-8") if _site_path(domain).exists() else None

    cert_path.write_text("\n".join(certs) + "\n", encoding="utf-8")
    key_path.write_text(keys[0] + "\n", encoding="utf-8")
    os.chmod(cert_path, 0o644)
    os.chmod(key_path, 0o600)

    write_site_config(domain, with_ssl=True,
                      cert_path=str(cert_path), key_path=str(key_path))
    ok, out = nginx_reload()
    if not ok:
        if prev is not None:
            _site_path(domain).write_text(prev, encoding="utf-8")
        else:
            remove_site_config(domain)
        _run(["systemctl", "reload", "nginx"], timeout=30)
        raise CertError(f"nginx не принял сертификат: {out[:300]}")

    logger.info("Загружен сертификат для %s (%s, до %s)",
                domain, res["issuer"], res["expires_at"])
    return res


def live_cert_info(domain: str) -> dict:
    """Что РЕАЛЬНО отдаётся посетителю — проверка по сети, а не по файлу.

    ⚠️ Смотрим глазами посетителя: файл на диске может быть свежим, а домен
    уведён на чужой сервер, или nginx не перечитал конфиг.
    """
    domain = domain.strip().lower()
    code, out = _run([
        "openssl", "s_client", "-connect", f"{domain}:443",
        "-servername", domain, "-verify_return_error"], timeout=25, stdin_null=True)
    if "BEGIN CERTIFICATE" not in out:
        return {"ok": False, "error": "Сайт не отвечает по HTTPS"}

    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "s.pem"
        blocks = _pem_blocks(out, "CERTIFICATE")
        if not blocks:
            return {"ok": False, "error": "Сервер не отдал сертификат"}
        p.write_text(blocks[0] + "\n", encoding="utf-8")
        _, info = _run(["openssl", "x509", "-in", str(p), "-noout",
                        "-issuer", "-enddate"], timeout=20)

    issuer = re.search(r"CN\s*=\s*([^\n/]+)", info)
    exp = re.search(r"notAfter=(.+)", info)
    expires_at = None
    if exp:
        try:
            expires_at = datetime.strptime(exp.group(1).strip(), "%b %d %H:%M:%S %Y %Z")
        except Exception:
            pass
    days = (expires_at - datetime.utcnow()).days if expires_at else None
    return {"ok": True, "error": None,
            "issuer": (issuer.group(1).strip() if issuer else "—"),
            "expires_at": expires_at, "days_left": days,
            "chain_len": len(_pem_blocks(out, "CERTIFICATE"))}


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
