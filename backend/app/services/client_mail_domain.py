"""
Почта с домена клиента: DKIM-ключ, регистрация в OpenDKIM, проверка DNS.

Схема (вариант «свой домен на нашем Postfix»):
  письма уходят с нашего сервера, но From = noreply@домен-клиента. Клиент
  добавляет в свой DNS три записи — SPF, DKIM, DMARC. Мы генерим ему
  отдельный DKIM-ключ и прописываем домен в KeyTable/SigningTable OpenDKIM.

Почему не «клиент даёт свой SMTP»: Яндекс 360 / Mail.ru дают ~500 писем в
сутки на ящик и блокируют признаки массовой рассылки. Рассылка по базе
события — это тысячи писем разом, она бы просто не прошла. Свой Postfix
лимитов не имеет и позволяет управлять темпом (у нас уже есть отдельный
медленный транспорт под Gmail).

⚠️ Репутация общая. Домен клиента шлёт с нашего IP, поэтому чужой спам бьёт
по всем. Фича выдаётся не всем подряд, а bounce-статистику по клиенту нужно
смотреть (см. tasks/email_bounce.py).

⚠️ Требует прав root (пишет в /etc/opendkim, дёргает systemctl). Вызывать
только из API-процесса — он работает под root; Celery запущен под www-data
и таких прав не имеет.
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

OPENDKIM_DIR = Path("/etc/opendkim")
KEYS_DIR = OPENDKIM_DIR / "keys"
KEY_TABLE = OPENDKIM_DIR / "KeyTable"
SIGNING_TABLE = OPENDKIM_DIR / "SigningTable"

# Селектор одинаковый у всех клиентов — он уникален в пределах ИХ домена,
# пересечься не может. Держим отдельно от системного 'mail', чтобы клиентские
# записи были видны в DNS как наши.
DEFAULT_SELECTOR = "plusonkey"

# Наш отправляющий IP — его клиент включает в свой SPF.
# Берётся из настроек Postfix; при переезде сервера поменять здесь.
SENDING_IP = "194.156.119.17"
SPF_INCLUDE_DOMAIN = "pluson.ru"


class MailDomainError(Exception):
    """Не удалось настроить почтовый домен клиента."""


def _run(cmd: list[str], *, timeout: int = 30) -> tuple[int, str]:
    """Выполнить команду, вернуть (код возврата, вывод)."""
    try:
        p = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
        return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()
    except subprocess.TimeoutExpired:
        return 124, f"Команда не уложилась в {timeout} с: {' '.join(cmd)}"
    except FileNotFoundError:
        return 127, f"Команда не найдена: {cmd[0]}"
    except Exception as e:  # pragma: no cover
        return 1, f"{e!r}"


# ── Генерация DKIM-ключа ────────────────────────────────────────────────────

def _parse_public_key(txt_path: Path) -> str:
    """Достать значение p=... из файла, который делает opendkim-genkey.

    Файл выглядит так:
        plusonkey._domainkey IN TXT ( "v=DKIM1; h=sha256; k=rsa; "
          "p=MIIBIjANBg..." )  ; ----- DKIM key
    Ключ разбит на строки в кавычках — их надо склеить.
    """
    raw = txt_path.read_text(encoding="utf-8", errors="replace")
    parts = re.findall(r'"([^"]*)"', raw)
    value = "".join(parts).strip()
    if not value:
        raise MailDomainError("Не удалось прочитать сгенерированный DKIM-ключ")
    return value


def generate_dkim_key(domain: str, selector: str = DEFAULT_SELECTOR) -> str:
    """Создать DKIM-ключ для домена и вернуть публичную часть для DNS.

    Идемпотентна: если ключ уже есть — просто читаем публичную часть, чтобы
    повторное нажатие «Проверить» не сломало уже работающую подпись.
    """
    domain = domain.strip().lower()
    if not domain:
        raise MailDomainError("Пустой домен")

    dom_dir = KEYS_DIR / domain
    private = dom_dir / f"{selector}.private"
    public = dom_dir / f"{selector}.txt"

    if private.exists() and public.exists():
        return _parse_public_key(public)

    dom_dir.mkdir(parents=True, exist_ok=True)

    code, out = _run([
        "opendkim-genkey",
        "-b", "2048",
        "-d", domain,
        "-s", selector,
        "-D", str(dom_dir),
    ], timeout=60)
    if code != 0:
        raise MailDomainError(f"opendkim-genkey не отработал: {out}")

    if not private.exists() or not public.exists():
        raise MailDomainError("opendkim-genkey отработал, но файлы ключа не появились")

    # Приватный ключ читает демон OpenDKIM — иначе подпись не встанет.
    _run(["chown", "-R", "opendkim:opendkim", str(dom_dir)])
    os.chmod(private, 0o600)

    return _parse_public_key(public)


# ── Регистрация домена в OpenDKIM ───────────────────────────────────────────

def _append_line_once(path: Path, line: str, *, match_prefix: str) -> bool:
    """Дописать строку в таблицу, если её там ещё нет. True = дописали."""
    existing = ""
    if path.exists():
        existing = path.read_text(encoding="utf-8", errors="replace")
    for row in existing.splitlines():
        if row.strip().startswith(match_prefix):
            return False
    with path.open("a", encoding="utf-8") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(line.rstrip("\n") + "\n")
    return True


def register_domain_in_opendkim(domain: str, selector: str = DEFAULT_SELECTOR) -> bool:
    """Прописать домен в KeyTable и SigningTable. True = конфиг изменился.

    KeyTable:     <selector>._domainkey.<domain> <domain>:<selector>:<путь к ключу>
    SigningTable: *@<domain>  <selector>._domainkey.<domain>
    """
    domain = domain.strip().lower()
    key_id = f"{selector}._domainkey.{domain}"
    private = KEYS_DIR / domain / f"{selector}.private"

    if not private.exists():
        raise MailDomainError(f"Нет приватного ключа для {domain} — сначала сгенерируйте")

    changed = _append_line_once(
        KEY_TABLE,
        f"{key_id} {domain}:{selector}:{private}",
        match_prefix=key_id,
    )
    changed |= _append_line_once(
        SIGNING_TABLE,
        f"*@{domain} {key_id}",
        match_prefix=f"*@{domain} ",
    )

    if changed:
        code, out = _run(["systemctl", "reload", "opendkim"], timeout=30)
        if code != 0:
            # reload не у всех сборок поддержан — пробуем restart
            code, out = _run(["systemctl", "restart", "opendkim"], timeout=30)
        if code != 0:
            raise MailDomainError(f"OpenDKIM не перечитал конфиг: {out}")
        logger.info("OpenDKIM: домен %s подключён (selector=%s)", domain, selector)
    return changed


def unregister_domain_from_opendkim(domain: str) -> None:
    """Убрать домен из таблиц OpenDKIM. Ключи на диске оставляем.

    Ключи не удаляем намеренно: если клиент вернёт домен, DNS-запись у него
    уже стоит и подпись подойдёт — не придётся заново менять DNS.
    """
    domain = domain.strip().lower()
    for path, needle in ((KEY_TABLE, f"._domainkey.{domain} "), (SIGNING_TABLE, f"*@{domain} ")):
        if not path.exists():
            continue
        rows = path.read_text(encoding="utf-8", errors="replace").splitlines()
        kept = [r for r in rows if needle not in r]
        if len(kept) != len(rows):
            path.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    _run(["systemctl", "reload", "opendkim"], timeout=30)


# ── Что клиент должен прописать в своём DNS ─────────────────────────────────

def dns_records_for(domain: str, dkim_public: str,
                    selector: str = DEFAULT_SELECTOR) -> list[dict]:
    """Три записи для DNS клиента — ровно в том виде, как показываем в кабинете."""
    return [
        {
            "kind": "spf",
            "type": "TXT",
            "host": "@",
            "value": f"v=spf1 include:{SPF_INCLUDE_DOMAIN} ip4:{SENDING_IP} ~all",
            "title": "SPF — разрешает нашему серверу слать от вашего имени",
            "note": (
                "Если TXT-запись SPF на домене уже есть — не добавляйте вторую, "
                f"а впишите include:{SPF_INCLUDE_DOMAIN} в существующую. "
                "Две записи SPF ломают проверку."
            ),
        },
        {
            "kind": "dkim",
            "type": "TXT",
            "host": f"{selector}._domainkey",
            "value": dkim_public,
            "title": "DKIM — подпись писем",
            "note": "Длинное значение. Копируйте целиком, одной строкой.",
        },
        {
            "kind": "dmarc",
            "type": "TXT",
            "host": "_dmarc",
            "value": f"v=DMARC1; p=none; rua=mailto:dmarc@{domain}",
            "title": "DMARC — политика проверки",
            "note": (
                "p=none — только наблюдение, письма не отбрасываются. "
                "Ужесточать до quarantine/reject можно через месяц стабильной отправки."
            ),
        },
    ]
