"""
Проверка DNS своих доменов клиента.

Две разные проверки:
  • лендинги — CNAME домена ведёт на нас (или A-запись на наш IP);
  • почта    — в домене есть SPF с нашим include, DKIM-ключ и DMARC.

⚠️ Проверяем через ПУБЛИЧНЫЕ резолверы (8.8.8.8 / 1.1.1.1), а не через
системный. Локальный резолвер на сервере может отдавать закешированный
ответ или свою зону, и тогда клиент увидит «DNS не сошёлся», хотя снаружи
всё видно. Смотрим глазами интернета, а не сервера.

⚠️ Кнопку «Выпустить сертификат» открываем только после успешной проверки.
Let's Encrypt даёт 5 неудачных попыток в час на домен — если дать клиенту
жать по неготовому DNS, он упрётся в лимит и не сможет выпустить сертификат
ещё час, уже когда DNS дойдёт.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from app.services import client_domains, dns_providers

logger = logging.getLogger(__name__)

# Публичные резолверы: Google и Cloudflare.
PUBLIC_RESOLVERS = ["8.8.8.8", "1.1.1.1"]
DNS_TIMEOUT_SEC = 5.0

# Наш IP — на случай, если вызывающий не передал expect_ip (тогда в тексте
# ошибки клиенту всё равно должен быть конкретный адрес, а не пустое место).
SENDING_IP_FALLBACK = "194.156.119.17"


def _resolver():
    import dns.resolver  # локальный импорт: модуль нужен не на каждом старте

    r = dns.resolver.Resolver(configure=False)
    r.nameservers = list(PUBLIC_RESOLVERS)
    r.timeout = DNS_TIMEOUT_SEC
    r.lifetime = DNS_TIMEOUT_SEC * 2
    return r


def _query_sync(name: str, rdtype: str) -> list[str]:
    """Синхронный запрос. Пустой список — записи нет либо резолвер не ответил."""
    import dns.resolver

    try:
        answers = _resolver().resolve(name, rdtype)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        return []
    except Exception as e:
        logger.debug("DNS %s %s: %r", rdtype, name, e)
        return []

    out: list[str] = []
    for a in answers:
        if rdtype == "TXT":
            # TXT приходит кусками по 255 символов — склеиваем (длинный DKIM-ключ
            # почти всегда разбит, и без склейки его не сматчить).
            chunks = getattr(a, "strings", None)
            if chunks:
                out.append(b"".join(chunks).decode("utf-8", errors="replace"))
            else:
                out.append(str(a).strip('"'))
        else:
            out.append(str(a).rstrip("."))
    return out


async def _query(name: str, rdtype: str) -> list[str]:
    """Не блокируем event loop — DNS может отвечать секунды."""
    return await asyncio.to_thread(_query_sync, name, rdtype)


# ── Кто управляет DNS домена ────────────────────────────────────────────────

async def detect_provider(domain: str) -> tuple[list[str], Optional[dict]]:
    """(NS-серверы, описание панели провайдера).

    Нужно, чтобы показать клиенту инструкцию под ЕГО панель, а не общую.
    ⚠️ NS спрашиваем у КОРНЯ домена: у поддомена (lp.example.ru) своих
    NS-записей нет, ответ был бы пустым и провайдер не определился бы
    именно у тех, кто подключает поддомен.
    """
    apex = client_domains.apex_of(domain)
    if not apex:
        return [], None
    ns = [n.lower() for n in await _query(apex, "NS")]
    return ns, dns_providers.detect(ns)


# ── Домен лендингов ─────────────────────────────────────────────────────────

async def check_landing_dns(domain: str, *, expect_host: str,
                            expect_ip: Optional[str] = None) -> dict:
    """Ведёт ли домен клиента на нас.

    Принимаем оба варианта:
      • CNAME → pluson.ru — для ПОДДОМЕНА (lp.example.ru);
      • A-запись → наш IP — для КОРНЯ домена (example.ru), где CNAME
        невозможен в принципе (стандарт DNS).

    ⚠️ Текст ошибки зависит от того, корень это или поддомен: советовать
    владельцу корневого домена «поставьте CNAME» — отправлять его в тупик,
    такую запись регистратор не сохранит.
    """
    domain = domain.strip().lower().rstrip(".")
    expect_host = expect_host.strip().lower().rstrip(".")

    # Провайдера определяем ТЕМ ЖЕ заходом, параллельно: отдельный запрос
    # после проверки добавил бы клиенту лишние секунды ожидания кнопки.
    cnames_raw, a_records, (ns_records, provider) = await asyncio.gather(
        _query(domain, "CNAME"),
        _query(domain, "A"),
        detect_provider(domain),
    )
    cnames = [c.lower() for c in cnames_raw]

    cname_ok = any(c == expect_host or c.endswith("." + expect_host) for c in cnames)
    ip_ok = bool(expect_ip) and expect_ip in a_records

    apex = client_domains.is_apex_domain(domain)
    if apex:
        need = f"A-запись «@» → {expect_ip or SENDING_IP_FALLBACK}"
    else:
        need = f"CNAME {domain} → {expect_host}"

    ok = cname_ok or ip_ok
    if ok:
        message = "DNS настроен верно"
    elif cnames or a_records:
        found = ", ".join(cnames + a_records) or "—"
        extra = (" Старую запись нужно удалить или изменить — "
                 "две разные записи одновременно работать не будут."
                 if apex and a_records else "")
        message = f"Домен ведёт не на нас (сейчас: {found}). Нужна {need}.{extra}"
    else:
        message = (
            f"Записи не найдены. Добавьте у регистратора {need} "
            "и подождите — обновление занимает от нескольких минут "
            "до пары часов"
        )

    return {
        "ok": ok,
        "message": message,
        "cname": cnames,
        "a": a_records,
        "expect_host": expect_host,
        "expect_ip": expect_ip,
        # Где клиент правит DNS: показываем инструкцию под его панель.
        # provider = None — провайдер неизвестен, кабинет покажет общую.
        "ns": ns_records,
        "provider": provider,
    }


# ── Домен почты ─────────────────────────────────────────────────────────────

async def check_mail_dns(domain: str, *, dkim_selector: str,
                         dkim_public: str | None = None,
                         spf_include: str = "pluson.ru",
                         sending_ip: str | None = None) -> dict:
    """SPF + DKIM + DMARC в домене клиента. Каждая запись проверяется отдельно."""
    domain = domain.strip().lower().rstrip(".")

    root_txt, dkim_txt, dmarc_txt, (ns_records, provider) = await asyncio.gather(
        _query(domain, "TXT"),
        _query(f"{dkim_selector}._domainkey.{domain}", "TXT"),
        _query(f"_dmarc.{domain}", "TXT"),
        detect_provider(domain),
    )

    # ── SPF ──
    spf_records = [t for t in root_txt if t.strip().lower().startswith("v=spf1")]
    spf_ok = False
    if len(spf_records) > 1:
        spf_msg = (
            "Найдено несколько SPF-записей — почтовики считают это ошибкой "
            "и проверка не пройдёт. Оставьте одну, объединив содержимое"
        )
    elif spf_records:
        rec = spf_records[0].lower()
        has_include = f"include:{spf_include.lower()}" in rec
        has_ip = bool(sending_ip) and f"ip4:{sending_ip}" in rec
        spf_ok = has_include or has_ip
        spf_msg = (
            "SPF в порядке" if spf_ok
            else f"В SPF нет нашего сервера — добавьте include:{spf_include}"
        )
    else:
        spf_msg = "SPF-запись не найдена"

    # ── DKIM ──
    dkim_found = [t for t in dkim_txt if "p=" in t]
    dkim_ok = False
    if not dkim_found:
        dkim_msg = f"DKIM-запись не найдена ({dkim_selector}._domainkey.{domain})"
    elif dkim_public:
        # Сравниваем именно тело ключа: значение в DNS может отличаться
        # порядком параметров и пробелами, а p=... должен совпасть точно.
        want = _extract_dkim_p(dkim_public)
        got = _extract_dkim_p(dkim_found[0])
        dkim_ok = bool(want) and want == got
        dkim_msg = (
            "DKIM в порядке" if dkim_ok
            else "DKIM-запись есть, но ключ отличается от выданного — "
                 "скопируйте значение целиком, без переносов"
        )
    else:
        dkim_ok = True
        dkim_msg = "DKIM-запись найдена"

    # ── DMARC ──
    dmarc_found = [t for t in dmarc_txt if t.strip().lower().startswith("v=dmarc1")]
    dmarc_ok = bool(dmarc_found)
    dmarc_msg = "DMARC в порядке" if dmarc_ok else "DMARC-запись не найдена"

    return {
        # Домен считается рабочим при SPF+DKIM. DMARC желателен, но письма
        # доходят и без него — не блокируем клиента из-за него.
        "ok": spf_ok and dkim_ok,
        "spf": {"ok": spf_ok, "message": spf_msg, "found": spf_records},
        "dkim": {"ok": dkim_ok, "message": dkim_msg, "found": dkim_found},
        "dmarc": {"ok": dmarc_ok, "message": dmarc_msg, "found": dmarc_found},
        # Панель, где клиент правит DNS (то же, что у домена лендингов).
        "ns": ns_records,
        "provider": provider,
    }


def _extract_dkim_p(value: str) -> str:
    """Вытащить тело ключа (p=...) из DKIM-записи, игнорируя пробелы."""
    for part in value.replace(" ", "").split(";"):
        if part.startswith("p="):
            return part[2:]
    return ""
