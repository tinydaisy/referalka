"""
Письмо покупателю «доступ заканчивается» за 3 дня до окончания (миграция 369).

Зачем. Срок доступа истекает МОЛЧА: человек заходит в кабинет и видит «срок
истёк» вместо материалов — там же, где вчера всё работало. Это читается как
поломка, и первое, что он делает, — пишет клиенту «у меня всё сломалось».
Предупреждение за несколько дней даёт ему время продлить или скачать нужное.

⚠️ Отметка `expiry_warned_at` обязательна: задача бежит раз в час, и без неё
одно и то же письмо уходило бы 24 раза в сутки. По той же причине здесь
счётчик-отметка, а не проверка «сегодня ли N-й день».

⚠️ Отметка снимается при продлении срока (`update_access`) — иначе о НОВОМ
окончании человека уже не предупредили бы.

⚠️ `asyncio.set_event_loop(loop)` обязателен — иначе библиотеки внутри берут
закрытый цикл предыдущей задачи того же воркера (правило проекта).
"""
from __future__ import annotations

import logging

from celery import shared_task

from app.database import get_pool

logger = logging.getLogger(__name__)

# За сколько дней предупреждаем. Одно письмо, не серия: доступ к материалам —
# не подписка, торговаться тут не о чем, лишние письма только раздражают.
WARN_DAYS = 3


def _run_async(coro):
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@shared_task(name="app.tasks.product_access_expiry.notify_expiring_access")
def notify_expiring_access():
    return _run_async(_notify())


async def _notify():
    pool = await get_pool()
    sent = 0
    async with pool.acquire() as db:
        rows = await db.fetch(
            f"""SELECT pa.id, pa.contact_id, pa.expires_at,
                       p.id AS product_id, p.client_id, p.title, p.slug,
                       p.wording_preset
                  FROM product_access pa
                  JOIN products p ON p.id = pa.product_id
                 WHERE pa.revoked_at IS NULL
                   AND pa.expiry_warned_at IS NULL
                   AND pa.expires_at IS NOT NULL
                   AND pa.expires_at > NOW()
                   AND pa.expires_at <= NOW() + INTERVAL '{WARN_DAYS} days'
                 LIMIT 500"""
        )
        for r in rows:
            try:
                await _send_one(db, r)
                sent += 1
            except Exception:
                logger.exception("Письмо об окончании доступа %s не ушло", r["id"])
            finally:
                # ⚠️ Отметку ставим ДАЖЕ при неудаче: иначе сломанный адрес
                # заставит задачу долбиться в него каждый час бесконечно.
                await db.execute(
                    "UPDATE product_access SET expiry_warned_at = NOW() WHERE id = $1",
                    r["id"],
                )
    return {"sent": sent}


async def _send_one(db, r) -> None:
    from app.services.product_notify import wording, _email_channel, _send_to_bot
    from app.services.client_domains import client_public_link, client_public_url
    from app.services.product_access import log_access_event

    W = wording(r["wording_preset"])
    url = await client_public_link(db, r["client_id"], f"/my/{r['slug']}")
    when = r["expires_at"].strftime("%d.%m.%Y")

    await _send_to_bot(
        db, r["client_id"], r["contact_id"],
        f"⏳ Доступ к «{r['title']}» заканчивается {when}.\n\n"
        f"{W['units'].capitalize()} пока открыты: {url}",
    )

    info = await db.fetchrow(
        """SELECT c.name,
                  (SELECT pe.platform_user_id FROM platform_users pe
                    WHERE pe.contact_id = c.id AND pe.platform_slug = 'email'
                      AND COALESCE(pe.email_is_dead, FALSE) = FALSE
                    ORDER BY pe.id LIMIT 1) AS email,
                  cl.name AS client_name, cl.brand_name
             FROM contacts c JOIN clients cl ON cl.id = $2
            WHERE c.id = $1""",
        r["contact_id"], r["client_id"],
    )
    if not info or not info["email"]:
        await log_access_event(db, r["id"], "email_sent", actor="system",
                               detail=f"предупреждение об окончании {when}: только бот")
        return

    channel = await _email_channel(db, r["client_id"])
    if not channel:
        return

    from app.services.email_sender import EmailSender
    from app.services.unsubscribe_token import make_email_unsubscribe_token
    from app.services.client_domains import client_mail_domain

    brand = info["brand_name"] or info["client_name"]
    channel_dict = dict(channel)
    mail = await client_mail_domain(db, r["client_id"])
    if mail:
        channel_dict["email_domain"] = mail["domain"]
        channel_dict["email_from_local"] = mail["local"]
        if mail["from_name"]:
            channel_dict["email_from_name"] = mail["from_name"]

    name = (info["name"] or "").strip()
    EmailSender().send(
        channel=channel_dict,
        client_brand_name=brand,
        to_email=info["email"],
        subject=f"Доступ к «{r['title']}» заканчивается {when}",
        body_text=(
            f"{'Здравствуйте, ' + name + '!' if name else 'Здравствуйте!'}\n\n"
            f"Доступ к «{r['title']}» открыт до {when}.\n\n"
            f"{W['units'].capitalize()} здесь:\n{url}\n\n"
            f"Если нужно продлить — ответьте на это письмо.\n\n{brand}"
        ),
        unsubscribe_token=make_email_unsubscribe_token(
            client_id=r["client_id"], contact_id=r["contact_id"],
            client_channel_id=channel["client_channel_id"],
        ),
        public_base_url=await client_public_url(db, r["client_id"]),
    )
    await log_access_event(db, r["id"], "email_sent", actor="system",
                           detail=f"предупреждение об окончании {when}")
