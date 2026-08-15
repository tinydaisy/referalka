"""
Напоминания о неактивированном бонусе ПЛЮСОНа (миграция 308).

Человек оплатил, письмо получил, но по ссылке не перешёл — значит доступа у
него нет, а он за него заплатил. Напоминаем шесть раз по согласованному
графику и замолкаем.

⚠️ ГРАФИК (решение владельца): 3, 14, 30, 60 день после выдачи + за 7 и за
1 день до сгорания ссылки. Еженедельно все 90 дней — это 12 писем, их
пометят спамом, и пострадает доставляемость ВСЕЙ почты платформы, включая
рассылки клиентов.

⚠️ Считаем по `reminders_sent`, а не по «прошло ли N дней»: задача бежит
раз в час, и без счётчика одно и то же напоминание ушло бы 24 раза за сутки.

⚠️ Активированный купон не трогаем вовсе — человек уже забрал доступ.
"""
import asyncio
import logging
from datetime import datetime, timezone

from app.celery_app import celery_app
from app.database import get_pool

logger = logging.getLogger(__name__)

# (номер напоминания, через сколько дней ПОСЛЕ выдачи слать).
# Последние два считаются от конца: 90-7=83 и 90-1=89.
SCHEDULE = [
    (1, 3),
    (2, 14),
    (3, 30),
    (4, 60),
    (5, 83),
    (6, 89),
]


@celery_app.task(name="app.tasks.plusson_bonus_reminders.send_reminders")
def send_reminders():
    return asyncio.run(_run())


async def _run() -> dict:
    from app.services import plusson_bonus_texts as T
    from app.services.plusson_bonus import _link  # noqa: используем формат ссылки

    pool = await get_pool()
    sent = 0
    async with pool.acquire() as db:
        rows = await db.fetch(
            """SELECT id, email, contact_id, issuer_client_id, feature_id, days,
                      created_at, expires_at, reminders_sent, token
                 FROM plusson_bonus_coupons
                WHERE activated_at IS NULL
                  AND expires_at > NOW()
                  AND reminders_sent < $1
                ORDER BY id""",
            len(SCHEDULE),
        )
        now = datetime.now(timezone.utc)

        for r in rows:
            step = int(r["reminders_sent"]) + 1
            due_days = dict(SCHEDULE).get(step)
            if due_days is None:
                continue
            age_days = (now - r["created_at"]).days
            if age_days < due_days:
                continue

            days_left = max(0, (r["expires_at"] - now).days)
            what = "доступ в iViSiON: ПЛЮСОН"
            if r["feature_id"]:
                name = await db.fetchval(
                    "SELECT name FROM features WHERE id = $1", r["feature_id"])
                if name:
                    what = f"доступ в iViSiON: ПЛЮСОН и модуль «{name}»"

            # ⚠️ Ведём по РАБОЧЕЙ ссылке (мигр. 310): отправлять «поищите
            # ссылку в старом письме» бессмысленно — человек потерялся ровно
            # там. Токена нет (старый купон) — напоминание пропускаем.
            if not r["token"]:
                continue
            subject, body = T.reminder(
                subject_line="Напоминаем про ваш доступ в iViSiON: ПЛЮСОН",
                what=what,
                link=_link(r["token"]),
                days_left=days_left,
            )
            try:
                await _send_mail(db, r["email"], subject, body,
                                 r["issuer_client_id"], r["contact_id"])
                await db.execute(
                    """UPDATE plusson_bonus_coupons
                          SET reminders_sent = $2, last_reminder_at = NOW()
                        WHERE id = $1""",
                    r["id"], step)
                sent += 1
            except Exception:
                logger.warning("bonus-reminder: письмо на %s не ушло", r["email"])

    if sent:
        logger.info("bonus-reminder: отправлено %s напоминаний", sent)
    return {"sent": sent}


async def _send_mail(db, email: str, subject: str, body: str,
                     client_id, contact_id) -> None:
    from app.services.email_sender import EmailSender
    from app.services.unsubscribe_token import make_email_unsubscribe_token
    ch = await db.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local
             FROM client_channels cc JOIN channels ch ON ch.id = cc.channel_id
            WHERE ch.platform_slug = 'email' AND ch.is_system = TRUE
            LIMIT 1""")
    if not ch:
        return
    channel = dict(ch)
    channel["email_from_name"] = "iViSiON: ПЛЮСОН"
    EmailSender().send(
        channel=channel, client_brand_name="iViSiON: ПЛЮСОН",
        to_email=email, subject=subject, body_text=body,
        unsubscribe_token=make_email_unsubscribe_token(
            client_id=client_id or 0, contact_id=contact_id or 0,
            client_channel_id=ch["client_channel_id"] or 0),
    )
