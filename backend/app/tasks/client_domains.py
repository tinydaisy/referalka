"""
Мониторинг доменов клиентов (миграция 270) — раз в сутки.

Зачем. Сертификат Let's Encrypt живёт 90 дней, certbot.timer продлевает его
сам. Но если клиент снял CNAME или перенёс домен к другому провайдеру,
продление молча провалится — и в какой-то день его лендинги просто перестанут
открываться, без единого сигнала. Поэтому проверяем срок сами и заранее
предупреждаем клиента, пока всё ещё можно починить.

⚠️ Срок берём ПО СЕТИ (TLS-рукопожатие с доменом), а не из /etc/letsencrypt:
   • Celery работает под www-data, а /etc/letsencrypt/live доступен только
     root — файлы прочитать нечем;
   • по сети мы видим ровно то, что видит посетитель. Если домен увели на
     другой сервер, файл на диске будет свежим, а люди — упираться в чужой
     сертификат. Такую поломку проверка файлов не заметила бы.
"""
from __future__ import annotations

import asyncio
import logging
import socket
import ssl
from datetime import datetime, timezone

from celery import shared_task

from app.database import get_pool

logger = logging.getLogger(__name__)

# За сколько дней до конца предупреждаем клиента.
WARN_DAYS = (14, 7, 3, 1)

TLS_TIMEOUT_SEC = 10


def _run_async(coro):
    """Celery-таск синхронный, а вся работа с БД — async."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


def _peer_cert_expiry(domain: str) -> datetime | None:
    """Дата окончания сертификата, который домен реально отдаёт наружу."""
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((domain, 443), timeout=TLS_TIMEOUT_SEC) as sock:
            with ctx.wrap_socket(sock, server_hostname=domain) as tls:
                cert = tls.getpeercert()
    except Exception as e:
        logger.info("TLS %s: %r", domain, e)
        return None

    raw = (cert or {}).get("notAfter")
    if not raw:
        return None
    try:
        # Формат OpenSSL: 'Nov  3 14:36:49 2026 GMT'
        return datetime.strptime(raw, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


async def _check_domains() -> dict:
    pool = await get_pool()
    checked = warned = broken = 0

    async with pool.acquire() as db:
        try:
            rows = await db.fetch(
                """
                SELECT id, client_id, domain, cert_expires_at, status
                  FROM client_domains
                 WHERE kind = 'landing' AND status IN ('active', 'error')
                 ORDER BY id
                """
            )
        except Exception as e:
            # Таблицы ещё нет (миграция не накатана) — это не повод падать.
            logger.info("Мониторинг доменов пропущен: %r", e)
            return {"checked": 0, "warned": 0, "broken": 0}

        for row in rows:
            domain = row["domain"]
            checked += 1

            expiry = await asyncio.to_thread(_peer_cert_expiry, domain)

            if expiry is None:
                broken += 1
                await db.execute(
                    """
                    UPDATE client_domains
                       SET status = 'error',
                           last_error = 'Домен не отвечает по HTTPS — проверьте, '
                                        'что DNS-запись на месте',
                           last_error_at = NOW(), updated_at = NOW()
                     WHERE id = $1
                    """,
                    row["id"],
                )
                await _notify(db, row["client_id"], domain, days=None)
                continue

            days = (expiry - datetime.now(timezone.utc)).days

            await db.execute(
                """
                UPDATE client_domains
                   SET cert_expires_at = $2,
                       status = 'active',
                       last_error = NULL, last_error_at = NULL,
                       updated_at = NOW()
                 WHERE id = $1
                """,
                row["id"], expiry,
            )

            # Предупреждаем ровно в контрольные дни, чтобы не слать каждый день.
            if days in WARN_DAYS:
                warned += 1
                await _notify(db, row["client_id"], domain, days=days)

    return {"checked": checked, "warned": warned, "broken": broken}


async def _notify(db, client_id: int, domain: str, *, days: int | None) -> None:
    """Сообщить клиенту. Молча выходим, если каналы уведомлений не настроены."""
    if days is None:
        text = (
            f"⚠️ Домен <b>{domain}</b> не отвечает по HTTPS.\n\n"
            "Ваши лендинги и страницы для участников сейчас могут не открываться. "
            "Проверьте, что DNS-запись домена на месте, и загляните в "
            "«Настройки» → «Свой домен»."
        )
    else:
        text = (
            f"🔔 Сертификат домена <b>{domain}</b> истекает через {days} дн.\n\n"
            "Обычно он продлевается сам. Это письмо — на случай, если "
            "продление не пройдёт: проверьте, что DNS-запись домена не менялась. "
            "Состояние видно в «Настройки» → «Свой домен»."
        )

    try:
        from app.services.channels import notify_organizer_all_channels
        await notify_organizer_all_channels(client_id, text, db)
    except Exception as e:
        logger.warning("Уведомление о домене %s не ушло: %r", domain, e)


@shared_task(name="app.tasks.client_domains.check_domains")
def check_domains():
    """Раз в сутки: обновить срок сертификатов и предупредить, если он на исходе."""
    result = _run_async(_check_domains())
    logger.info("Мониторинг доменов: %s", result)
    return result
