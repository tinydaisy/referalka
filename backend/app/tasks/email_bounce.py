"""
Bounce-обработка: парсит /var/log/mail.log за последний час, выявляет возвраты
(status=bounced или status=deferred с 5.x.x SMTP-кодом), пишет в email_bounce_log
и автоматически помечает hard-bounce адреса как «битые» (platform_users.email_is_dead=TRUE).

Запускается Celery-beat раз в час:
    'process-email-bounces': {
        'task': 'app.tasks.email_bounce.process_bounces',
        'schedule': crontab(minute=10),
    }

Логика парсинга:
- Postfix пишет в /var/log/mail.log строки вида:
    Mar 22 12:34:56 mail postfix/smtp[1234]: 18AC856262: to=<user@gmail.com>,
        relay=...[ip]:25, delay=0.5, ..., dsn=5.1.1, status=bounced (host ... said:
        550-5.1.1 The email account that you tried to reach does not exist...)
- Мы интересуемся только status=bounced / status=deferred.
- SMTP-код первой цифры: 5xx = hard, 4xx = soft.
- Дополнительно: ищем «User unknown», «account does not exist», «mailbox not found»
  → forced hard, независимо от 4xx/5xx.

После N последовательных bounces (>= 3 hard ИЛИ >= 5 soft за 30 дней) — адрес
помечается email_is_dead=TRUE и больше не получает рассылок. Это защита от
дальнейшего падения репутации.
"""
import asyncio
import re
import os
import logging
from datetime import datetime, timedelta
import asyncpg
from app.celery_app import celery
from app.config import settings

logger = logging.getLogger(__name__)

# Сколько последних строк лога читать (на dev/prod ~10-50K строк в час)
LOG_TAIL_LINES = 200_000
# Читаем текущий лог + предыдущий (после ночной ротации свежие bounces могут
# оказаться в .1). cleanup-строка (qid→message-id) и финальная status=bounced
# строка должны попасть в ОДНУ выборку, иначе связка теряется.
LOG_FILES = ["/var/log/mail.log", "/var/log/mail.log.1"]

# Паттерн для выделения нужных полей. Пример:
# May 22 08:34:33 mail postfix/smtp[1234]: 18AC856262: to=<user@gmail.com>, ..., dsn=5.1.1, status=bounced (...)
LINE_RE = re.compile(
    r'postfix/(?:smtp|qmgr|cleanup|bounce)\[\d+\]:\s+'
    r'(?P<qid>[A-Z0-9]+):\s+'
    r'to=<(?P<to>[^>]+)>'
    r'(?:,.*?)*?'
    r'(?:,\s*dsn=(?P<dsn>\d\.\d+\.\d+))?'
    r'(?:,.*?)*?'
    r',\s*status=(?P<status>bounced|deferred|sent|expired)'
    r'(?:\s*\((?P<message>[^)]*)\))?'
)

# postfix/cleanup пишет: «<qid>: message-id=<our-internal-id@pluson.ru>».
# По qid из bounce-строки мы находим внутренний Message-ID и обновляем
# broadcast_log.status='bounced' (по полю external_message_id).
MSGID_RE = re.compile(
    r'postfix/cleanup\[\d+\]:\s+(?P<qid>[A-Z0-9]+):\s+message-id=<(?P<msgid>[^>]+)>'
)

HARD_TRIGGERS = (
    "user unknown", "account does not exist", "mailbox not found",
    "no such user", "address rejected", "blocked", "domain does not exist",
    "no mx", "host or domain name not found",
)


def _read_tail(path: str, lines: int) -> list[str]:
    """Читает последние N строк файла без загрузки целиком в память."""
    if not os.path.exists(path):
        return []
    try:
        # Простой и надёжный способ: tail -n
        import subprocess
        result = subprocess.run(
            ["tail", "-n", str(lines), path],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            logger.warning(
                f"_read_tail: tail вернул код {result.returncode} для {path}. "
                f"stderr={result.stderr[:200]}. Скорее всего нет прав чтения "
                f"(/var/log/mail.log = 640 syslog:adm — добавь www-data в группу adm)."
            )
            return []
        return result.stdout.splitlines()
    except Exception as e:
        logger.warning(f"_read_tail failed: {e}")
        return []


def _read_logs(lines_per_file: int) -> list[str]:
    """Читает несколько лог-файлов Postfix (текущий + ротированный) и склеивает
    в один список в хронологическом порядке (старый .1 идёт первым)."""
    out: list[str] = []
    # .1 (более старый) сначала, текущий — последним, чтобы порядок строк был
    # хронологическим и карта qid→message-id успела наполниться до bounce-строк.
    for path in reversed(LOG_FILES):
        out.extend(_read_tail(path, lines_per_file))
    return out


def human_reason(dsn: str | None, message: str | None, recipient: str | None = None) -> str:
    """Человекочитаемая причина недоставки на русском — то, что увидит клиент.
    Никаких «bounce» и SMTP-кодов: только понятный текст «Не доставлено: …»."""
    msg = (message or "").lower()
    dom = ""
    if recipient and "@" in recipient:
        dom = recipient.split("@", 1)[1].lower()
    is_mailru = any(d in dom for d in ("mail.ru", "bk.ru", "inbox.ru", "list.ru", "internet.ru"))
    provider = "mail.ru" if is_mailru else ("Gmail" if "gmail" in dom else "почтовый сервис получателя")

    if "spam" in msg or "spam message rejected" in msg:
        return f"{provider} отклонил письмо как спам"
    if any(t in msg for t in ("user unknown", "does not exist", "no such user",
                              "mailbox not found", "recipient address rejected",
                              "unknown user", "no mailbox")):
        return "Такого адреса не существует"
    if "mailbox full" in msg or "out of storage" in msg or "quota" in msg or "over quota" in msg:
        return "Ящик получателя переполнен"
    if "blocked" in msg or "blacklist" in msg or "block list" in msg:
        return f"{provider} заблокировал отправителя"
    if "greylist" in msg or "greylisted" in msg or "try again" in msg:
        return "Временно отложено получателем (повторим позже)"
    if "relay access denied" in msg or "relay not permitted" in msg:
        return "Сервер получателя отклонил доставку"
    if "connection timed out" in msg or "connection refused" in msg or "no route" in msg:
        return "Сервер получателя недоступен"
    if dsn and dsn.startswith("5"):
        return f"{provider} отклонил письмо"
    if dsn and dsn.startswith("4"):
        return "Временная ошибка доставки (повторим позже)"
    return "Письмо не доставлено получателю"


def _classify(dsn: str | None, message: str | None, status: str) -> str:
    """Возвращает bounce_type: hard / soft / unknown."""
    msg = (message or "").lower()
    if any(t in msg for t in HARD_TRIGGERS):
        return "hard"
    if dsn:
        first = dsn[0]
        if first == "5":
            return "hard"
        if first == "4":
            return "soft"
    if status == "bounced":
        return "hard"
    if status == "deferred":
        return "soft"
    return "unknown"


@celery.task(name="app.tasks.email_bounce.process_bounces")
def process_bounces():
    asyncio.run(_process_bounces_async())


async def _process_bounces_async():
    conn = await asyncpg.connect(settings.database_url)
    try:
        lines = _read_logs(LOG_TAIL_LINES)
        if not lines:
            return

        # Какие qid уже видели в логе (защита от дублирования при следующем вызове)
        seen_qids = await conn.fetch(
            "SELECT raw_log FROM email_bounce_log WHERE bounced_at > NOW() - INTERVAL '2 hours'"
        )
        seen_qid_set = set()
        for r in seen_qids:
            for qm in re.finditer(r'qid=(\w+)', r["raw_log"] or ""):
                seen_qid_set.add(qm.group(1))

        new_bounces = 0
        new_dead = 0
        new_broadcast_bounced = 0

        # Сначала собираем карту qid → message-id для всех cleanup-строк лога.
        # Это нужно, чтобы для каждой bounce-строки сразу знать наш внутренний
        # Message-ID и обновить broadcast_log.status='bounced'.
        qid_to_msgid: dict[str, str] = {}
        for line in lines:
            mm = MSGID_RE.search(line)
            if mm:
                qid_to_msgid[mm.group("qid")] = mm.group("msgid")

        for line in lines:
            m = LINE_RE.search(line)
            if not m:
                continue
            qid = m.group("qid")
            status = m.group("status")
            if status in ("sent", "expired"):
                continue
            if qid in seen_qid_set:
                continue

            to_email = m.group("to").strip().lower()
            dsn = m.group("dsn")
            message = m.group("message")
            bounce_type = _classify(dsn, message, status)

            # Обновляем broadcast_log: 'sent' → 'bounced' (если есть Message-ID).
            # Постфикс заворачивает наш Message-ID в <…>, в broadcast_log мы
            # тоже храним с угловыми скобками — сравниваем как есть.
            msgid = qid_to_msgid.get(qid)
            if msgid and bounce_type in ("hard", "soft"):
                # bounce: внешняя система отказала — статус «bounced».
                # deferred (queue временно отложен) пока трактуем тоже как bounced,
                # потому что обычно после deferred → bounced в течение часа.
                # В error пишем ПОНЯТНУЮ русскую причину — её видит клиент в кабинете.
                reason_human = human_reason(dsn, message, to_email)
                res = await conn.execute(
                    """UPDATE broadcast_log
                          SET status = 'bounced',
                              error = $2
                        WHERE external_message_id = $1
                          AND status IN ('sent', 'sending')""",
                    f"<{msgid}>", reason_human[:500],
                )
                if "UPDATE" in res and "UPDATE 0" not in res:
                    new_broadcast_bounced += 1

            # Найдём client_id и client_channel_id по email-получателю
            # (берём первую найденную identity)
            pu = await conn.fetchrow(
                """SELECT pu.id AS pu_id, pu.client_id, pu.email_is_dead,
                          cc.id AS client_channel_id
                     FROM platform_users pu
                     LEFT JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                     LEFT JOIN client_channels cc ON cc.id = puc.client_channel_id
                     LEFT JOIN channels ch ON ch.id = cc.channel_id AND ch.platform_slug = 'email'
                    WHERE pu.platform_slug = 'email' AND pu.platform_user_id = $1
                    LIMIT 1""",
                to_email,
            )
            client_id = pu["client_id"] if pu else None
            cc_id = pu["client_channel_id"] if pu else None
            pu_id = pu["pu_id"] if pu else None

            await conn.execute(
                """INSERT INTO email_bounce_log
                       (client_channel_id, client_id, to_email,
                        bounce_type, smtp_code, smtp_message, raw_log)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)""",
                cc_id, client_id, to_email,
                bounce_type, dsn, (message or "")[:1000], f"qid={qid} | {line[:500]}",
            )
            new_bounces += 1

            # Hard-bounce → сразу помечаем адрес битым
            if bounce_type == "hard" and pu_id and pu and not pu["email_is_dead"]:
                await conn.execute(
                    """UPDATE platform_users
                          SET email_is_dead = TRUE,
                              email_dead_reason = $2,
                              email_dead_at = NOW()
                        WHERE id = $1""",
                    pu_id, f"hard_bounce: {message[:200] if message else dsn or 'unknown'}",
                )
                new_dead += 1

        # Soft-bounce: если ≥ 5 soft за последние 30 дней — тоже считаем мертвым
        soft_dead = await conn.fetch(
            """SELECT to_email
                 FROM email_bounce_log
                WHERE bounce_type = 'soft'
                  AND bounced_at > NOW() - INTERVAL '30 days'
                GROUP BY to_email HAVING COUNT(*) >= 5"""
        )
        for r in soft_dead:
            res = await conn.execute(
                """UPDATE platform_users
                      SET email_is_dead = TRUE,
                          email_dead_reason = 'multiple_soft_bounces',
                          email_dead_at = NOW()
                    WHERE platform_slug = 'email'
                      AND platform_user_id = $1
                      AND email_is_dead = FALSE""",
                r["to_email"],
            )
            if "UPDATE 1" in res:
                new_dead += 1

        # Помечаем bounce-записи processed
        await conn.execute(
            """UPDATE email_bounce_log SET processed = TRUE
                WHERE processed = FALSE
                  AND bounced_at > NOW() - INTERVAL '1 day'"""
        )

        logger.info(
            f"process_bounces: новых bounce={new_bounces}, помечено битых={new_dead}, "
            f"broadcast_log → bounced={new_broadcast_bounced}"
        )
    finally:
        await conn.close()
