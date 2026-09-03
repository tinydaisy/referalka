"""
Celery-задачи подписок (миграция 069+):
  - expire_overdue          — раз в час: помечает истёкшие подписки и паузит их рассылки.
  - notify_expiring         — раз в час: шлёт в @pluson_bot уведомления за 7/3/1 день до истечения.
"""
import asyncio
import logging
import httpx
import asyncpg
from celery import shared_task
from app.config import settings


log = logging.getLogger(__name__)


def _run_async(coro):
    """Helper: запустить async-функцию из синхронной Celery-таски."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError("loop closed")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


async def _expire_overdue_async() -> int:
    db = await asyncpg.connect(settings.database_url)
    try:
        # Помечаем истёкшие подписки
        rows = await db.fetch(
            """UPDATE client_subscriptions
                  SET status = 'expired', updated_at = NOW()
                WHERE status = 'active' AND expires_at <= NOW()
            RETURNING id, client_id"""
        )
        if not rows:
            return 0

        client_ids = [r["client_id"] for r in rows]
        # Паузим будущие рассылки этих клиентов
        await db.execute(
            """UPDATE broadcast_schedules
                  SET status = 'paused_subscription_expired'
                WHERE client_id = ANY($1::int[])
                  AND status IN ('draft', 'pending')
                  AND fire_at > NOW()""",
            client_ids,
        )
        log.info("expire_overdue: %s подписок переведено в expired, рассылки запаузены", len(rows))
        return len(rows)
    finally:
        await db.close()


@shared_task(name="app.tasks.subscriptions.expire_overdue")
def expire_overdue_task():
    """Раз в час: помечает истёкшие подписки и паузит будущие рассылки."""
    try:
        return _run_async(_expire_overdue_async())
    except Exception as e:
        log.exception("expire_overdue task failed: %s", e)
        return 0


async def _notify_expiring_async() -> int:
    """Шлём в @pluson_bot уведомления клиенту:
       за 7 дней до истечения / за 3 дня / за 1 день.
       Идемпотентность через client_subscriptions.notified_7d/3d/1d."""
    db = await asyncpg.connect(settings.database_url)
    sent_count = 0
    try:
        # 7 дней
        rows_7d = await db.fetch(
            """SELECT cs.id AS sub_id, cs.expires_at, c.id AS client_id, c.name,
                      c.notifications_telegram_chat_id AS chat_id, t.name AS tariff_name
                 FROM client_subscriptions cs
                 JOIN clients c ON c.id = cs.client_id
                 JOIN tariffs t ON t.id = cs.tariff_id
                WHERE cs.status = 'active'
                  AND cs.expires_at > NOW()
                  AND cs.expires_at <= NOW() + INTERVAL '7 days'
                  AND cs.notified_7d = FALSE
                  AND c.notifications_telegram_chat_id IS NOT NULL"""
        )
        for r in rows_7d:
            ok = await _send_pluson_message(
                r["chat_id"],
                f"⏰ Через 7 дней истекает ваша подписка на тариф «{r['tariff_name']}».\n"
                f"Дата окончания: {r['expires_at'].strftime('%d.%m.%Y')}.\n"
                f"Продлите в личном кабинете: {settings.frontend_url}/dashboard/settings",
                client_id=r["client_id"], db=db,
            )
            if ok:
                await db.execute(
                    "UPDATE client_subscriptions SET notified_7d = TRUE WHERE id = $1",
                    r["sub_id"],
                )
                sent_count += 1

        # 3 дня
        rows_3d = await db.fetch(
            """SELECT cs.id AS sub_id, cs.expires_at, c.id AS client_id, c.name,
                      c.notifications_telegram_chat_id AS chat_id, t.name AS tariff_name
                 FROM client_subscriptions cs
                 JOIN clients c ON c.id = cs.client_id
                 JOIN tariffs t ON t.id = cs.tariff_id
                WHERE cs.status = 'active'
                  AND cs.expires_at > NOW()
                  AND cs.expires_at <= NOW() + INTERVAL '3 days'
                  AND cs.notified_3d = FALSE
                  AND c.notifications_telegram_chat_id IS NOT NULL"""
        )
        for r in rows_3d:
            ok = await _send_pluson_message(
                r["chat_id"],
                f"⚠️ Через 3 дня истекает подписка «{r['tariff_name']}».\n"
                f"Дата окончания: {r['expires_at'].strftime('%d.%m.%Y')}.\n"
                f"Продлите чтобы рассылки продолжали работать: {settings.frontend_url}/dashboard/settings",
                client_id=r["client_id"], db=db,
            )
            if ok:
                await db.execute(
                    "UPDATE client_subscriptions SET notified_3d = TRUE WHERE id = $1",
                    r["sub_id"],
                )
                sent_count += 1

        # 1 день
        rows_1d = await db.fetch(
            """SELECT cs.id AS sub_id, cs.expires_at, c.id AS client_id, c.name,
                      c.notifications_telegram_chat_id AS chat_id, t.name AS tariff_name
                 FROM client_subscriptions cs
                 JOIN clients c ON c.id = cs.client_id
                 JOIN tariffs t ON t.id = cs.tariff_id
                WHERE cs.status = 'active'
                  AND cs.expires_at > NOW()
                  AND cs.expires_at <= NOW() + INTERVAL '1 day'
                  AND cs.notified_1d = FALSE
                  AND c.notifications_telegram_chat_id IS NOT NULL"""
        )
        for r in rows_1d:
            ok = await _send_pluson_message(
                r["chat_id"],
                f"🔴 Завтра истекает подписка «{r['tariff_name']}».\n"
                f"После {r['expires_at'].strftime('%d.%m.%Y %H:%M')} рассылки и редактирование станут недоступны.\n"
                f"Продлите: {settings.frontend_url}/dashboard/settings",
                client_id=r["client_id"], db=db,
            )
            if ok:
                await db.execute(
                    "UPDATE client_subscriptions SET notified_1d = TRUE WHERE id = $1",
                    r["sub_id"],
                )
                sent_count += 1

        if sent_count:
            log.info("notify_expiring: отправлено %s уведомлений", sent_count)

        # Email-уведомления на тот же email клиента (миграция 099).
        # Идемпотентность через notified_email_7d/3d/1d.
        email_sent = await _notify_expiring_email(db)
        if email_sent:
            log.info("notify_expiring_email: отправлено %s писем", email_sent)
        return sent_count + email_sent
    finally:
        await db.close()


async def _notify_expiring_email(db) -> int:
    """Шлёт письмо клиенту на его email о скором истечении подписки.
    Отдельные флаги notified_email_7d/3d/1d (миграция 099).
    Письмо уходит через системный email-канал ПЛЮСОНа (noreply@pluson.ru)."""
    from app.services.email_sender import EmailSender, EmailSendError
    from app.services.unsubscribe_token import make_email_unsubscribe_token

    sent_count = 0

    for days, flag in [(7, "notified_email_7d"), (3, "notified_email_3d"), (1, "notified_email_1d")]:
        rows = await db.fetch(
            f"""SELECT cs.id AS sub_id, cs.expires_at, cs.client_id,
                       c.email, c.name, c.brand_name, t.name AS tariff_name
                  FROM client_subscriptions cs
                  JOIN clients c ON c.id = cs.client_id
                  JOIN tariffs t ON t.id = cs.tariff_id
                 WHERE cs.status = 'active'
                   AND cs.expires_at > NOW()
                   AND cs.expires_at <= NOW() + INTERVAL '{days} days'
                   AND cs.{flag} = FALSE
                   AND c.email IS NOT NULL AND TRIM(c.email) <> ''"""
        )
        for r in rows:
            ch = await db.fetchrow(
                """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                          ch.email_subdomain, ch.email_from_local
                     FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id = $1
                      AND ch.platform_slug = 'email' AND ch.is_system = TRUE
                    LIMIT 1""",
                r["client_id"],
            )
            if not ch:
                continue
            channel_dict = dict(ch)
            channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"
            unsub_token = make_email_unsubscribe_token(
                client_id=r["client_id"], contact_id=0,
                client_channel_id=ch["client_channel_id"],
            )
            try:
                EmailSender().send(
                    channel=channel_dict,
                    client_brand_name="iViSiON: ПЛЮСОН",
                    to_email=r["email"],
                    subject=(
                        f"Через {days} дн{'я' if days < 5 else 'ей'} истекает подписка ПЛЮСОНа"
                        if days > 1 else "🔴 Завтра истекает подписка ПЛЮСОНа"
                    ),
                    body_text=(
                        f"Здравствуйте, {r['name'] or 'друг'}!\n\n"
                        f"Через {days} дн{'я' if days < 5 else 'ей'} истекает ваша подписка "
                        f"на тариф «{r['tariff_name']}» в ПЛЮСОНе.\n\n"
                        f"Дата окончания: {r['expires_at'].strftime('%d.%m.%Y %H:%M')} МСК.\n\n"
                        f"Продлите подписку, чтобы рассылки и редактирование продолжали работать:\n"
                        f"{settings.frontend_url}/dashboard/subscription\n\n"
                        f"— Команда ПЛЮСОН"
                    ),
                    unsubscribe_token=unsub_token,
                )
                await db.execute(
                    f"UPDATE client_subscriptions SET {flag} = TRUE WHERE id = $1",
                    r["sub_id"],
                )
                sent_count += 1
            except EmailSendError as e:
                log.warning("notify_expiring_email failed for client_id=%s: %s", r["client_id"], e)

    return sent_count


async def _send_pluson_message(chat_id: int, text: str, *, client_id: int, db) -> bool:
    """Отправка служебного уведомления клиенту в его канал уведомлений.
    Бот: свой (VIP) бот клиента, если есть; иначе системный @pluson_bot (автофолбэк).
    True если доставлено."""
    if not chat_id:
        return False
    from app.services.channels import send_to_notifications_channel
    try:
        return await send_to_notifications_channel(client_id, chat_id, text, db, parse_mode="HTML")
    except Exception as e:
        log.warning("Не удалось отправить уведомление о подписке (chat_id=%s): %s", chat_id, e)
        return False


@shared_task(name="app.tasks.subscriptions.notify_expiring")
def notify_expiring_task():
    """Раз в час: уведомления за 7/3/1 день до истечения."""
    try:
        return _run_async(_notify_expiring_async())
    except Exception as e:
        log.exception("notify_expiring task failed: %s", e)
        return 0
