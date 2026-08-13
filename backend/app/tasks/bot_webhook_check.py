"""Проверка ботов клиентов на чужой вебхук (2026-08-13).

Telegram отдаёт сообщения ТОЛЬКО ОДНОМУ получателю. Клиент подключает
своего бота к стороннему сервису (BotHelp, merexo…), тот ставит вебхук — и
наш polling перестаёт получать что-либо. У клиента молча отваливаются
воронки, подарки, проверка подписки и регистрация на события, а он об этом
не знает.

⚠️ Вебхук САМИ НЕ СНИМАЕМ — это сломает клиенту работу в его сервисе.
Обнаруживаем, сохраняем в channels.webhook_url и говорим клиенту.

⚠️ Уведомление (почта + бот ПЛЮСОНа) уходит ОДИН РАЗ на проблему —
`webhook_notified_at`. Долбить письмом каждый час нельзя. Плашка в кабинете
при этом висит, пока проблема есть: она читает webhook_url, а не флаг.
Починил → webhook_url и флаг обнуляются, и при повторной поломке письмо
придёт снова.

Раз в час: ~48 запросов к Telegram, нагрузки не создаёт. Проверять при
каждом заходе в кабинет нельзя — страница ждала бы ответа сети по каждому
боту.
"""
from __future__ import annotations

import logging

from celery import shared_task

from app.config import settings
from app.database import get_pool
from app.services.bot_webhook_watch import (
    bot_message_html,
    email_body_html,
    email_body_text,
    email_subject,
    fetch_webhook_url,
)

logger = logging.getLogger(__name__)


def _run_async(coro):
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


@shared_task(name="app.tasks.bot_webhook_check.check_bot_webhooks")
def check_bot_webhooks():
    """Раз в час: у каких ботов появился чужой вебхук."""
    return _run_async(_check())


async def _check() -> dict:
    pool = await get_pool()
    async with pool.acquire() as db:
        bots = await db.fetch(
            """SELECT ch.id, ch.handle, ch.bot_token, ch.webhook_url,
                      ch.webhook_notified_at
                 FROM channels ch
                WHERE ch.platform_slug = 'telegram'
                  AND ch.is_system = FALSE
                  AND COALESCE(ch.bot_token, '') <> ''"""
        )

        checked = broken = notified = fixed = 0

        for b in bots:
            url = await fetch_webhook_url(b["bot_token"])
            # ⚠️ None = спросить не удалось (сеть/лимит). Это НЕ «починено»:
            # обнулив здесь, мы погасили бы плашку у сломанного бота.
            if url is None:
                continue
            checked += 1

            if url:
                broken += 1
                await db.execute(
                    """UPDATE channels
                          SET webhook_url = $1, webhook_checked_at = NOW()
                        WHERE id = $2""",
                    url, b["id"],
                )
                # Уведомляем один раз на проблему.
                if not b["webhook_notified_at"]:
                    if await _notify(db, b["id"], b["handle"] or "бот", url):
                        notified += 1
                        await db.execute(
                            "UPDATE channels SET webhook_notified_at = NOW() WHERE id = $1",
                            b["id"],
                        )
            else:
                # Вебхука нет — всё в порядке. Сбрасываем и флаг: если клиент
                # снова подключит сторонний сервис, письмо придёт заново.
                if b["webhook_url"]:
                    fixed += 1
                await db.execute(
                    """UPDATE channels
                          SET webhook_url = NULL, webhook_notified_at = NULL,
                              webhook_checked_at = NOW()
                        WHERE id = $1""",
                    b["id"],
                )

        logger.info(
            "check_bot_webhooks: проверено=%s, с чужим вебхуком=%s, "
            "уведомлено=%s, починено=%s", checked, broken, notified, fixed,
        )
        return {"checked": checked, "broken": broken,
                "notified": notified, "fixed": fixed}


async def _notify(db, channel_id: int, handle: str, webhook_url: str) -> bool:
    """Письмо + сообщение в бот ПЛЮСОНа владельцу кабинета.

    Возвращает True, если ушло хоть куда-то: иначе флаг не ставим и в
    следующий час попробуем снова.
    """
    owners = await db.fetch(
        """SELECT cl.id, cl.email, cl.name
             FROM client_channels cc
             JOIN clients cl ON cl.id = cc.client_id
            WHERE cc.channel_id = $1""",
        channel_id,
    )
    if not owners:
        return False

    help_url = f"{settings.frontend_url}/dashboard/help"
    ok = False

    for o in owners:
        # 1. В каналы уведомлений клиента (TG/MAX/VK) — одной точкой.
        try:
            from app.services.channels import notify_organizer_all_channels
            res = await notify_organizer_all_channels(
                o["id"], bot_message_html(handle, webhook_url), db,
                kind="bot_webhook",
            )
            if any(res.values()):
                ok = True
        except Exception as e:                          # noqa: BLE001
            logger.warning("bot_webhook: уведомление в каналы не ушло (client=%s): %s",
                           o["id"], e)

        # 2. Письмо на почту клиента.
        if o["email"]:
            try:
                if await _send_email(db, o["id"], o["email"], handle,
                                     webhook_url, help_url):
                    ok = True
            except Exception as e:                      # noqa: BLE001
                logger.warning("bot_webhook: письмо не ушло (client=%s): %s",
                               o["id"], e)

    return ok


async def _send_email(db, client_id: int, to_email: str, handle: str,
                      webhook_url: str, help_url: str) -> bool:
    """Через системный email-канал ПЛЮСОНа, как уведомления о подписке."""
    from app.services.email_sender import EmailSender, EmailSendError
    from app.services.unsubscribe_token import make_email_unsubscribe_token

    ch = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND ch.platform_slug = 'email' AND ch.is_system = TRUE
            LIMIT 1""",
        client_id,
    )
    if not ch:
        return False

    channel = dict(ch)
    channel["email_from_name"] = "iViSiON: ПЛЮСОН"
    token = make_email_unsubscribe_token(
        client_id=client_id, contact_id=0,
        client_channel_id=ch["client_channel_id"],
    )
    try:
        EmailSender().send(
            channel=channel,
            client_brand_name="iViSiON: ПЛЮСОН",
            to_email=to_email,
            subject=email_subject(handle),
            body_text=email_body_text(handle, webhook_url, help_url),
            body_html=email_body_html(handle, webhook_url, help_url),
            unsubscribe_token=token,
        )
        return True
    except EmailSendError as e:
        logger.warning("bot_webhook: EmailSendError (client=%s): %s", client_id, e)
        return False
