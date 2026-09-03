"""
Предупреждения об истечении купленного модуля за 7 / 3 / 1 день (2026-08-10).

Зачем. Модуль (Конференции, Премии/Турниры, Коллабораторная) истекал МОЛЧА:
никакого события в системе не возникало, просто переставала выдаваться фича.
Клиент замечал это постфактум — по пропавшему разделу.

С 2026-08-10 у неоплаченного модуля ещё и останавливаются спикерские рассылки,
поэтому предупреждать заранее стало обязательным: иначе конференция «замолчит»
прямо посреди события, а жюри и спикеры упрутся в блокировку сохранения.

Устроено так же, как уведомления о подписке (tasks/subscriptions.py):
идемпотентность через флаги client_addons.notified_7d/3d/1d (миграция 276).
"""
from __future__ import annotations

import logging

from celery import shared_task

from app.database import get_pool

logger = logging.getLogger(__name__)

# (порог в днях, имя колонки-флага)
THRESHOLDS = ((7, "notified_7d"), (3, "notified_3d"), (1, "notified_1d"))


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


def _message(module_title: str, days: int, expires_at, has_events: bool) -> str:
    when = expires_at.strftime("%d.%m.%Y") if expires_at else ""
    day_word = "день" if days == 1 else "дня" if days < 5 else "дней"
    text = (
        f"⏰ Через {days} {day_word} заканчивается подписка на модуль "
        f"«{module_title}» (до {when}).\n\n"
    )
    if has_events:
        # Главное предупреждение — про рассылки. Клиент может не связать
        # «истёк модуль» с «участники перестали получать письма».
        text += (
            "У вас есть активные события этого типа. Если не продлить, "
            "рассылки по спикерам и программе остановятся, а редактирование "
            "станет недоступно — данные при этом сохранятся.\n\n"
        )
    text += "Продлить: /dashboard/subscription"
    return text


async def _notify_async() -> dict:
    pool = await get_pool()
    sent = 0

    async with pool.acquire() as db:
        for days, flag in THRESHOLDS:
            try:
                rows = await db.fetch(
                    f"""
                    SELECT ca.id, ca.client_id, ca.expires_at, f.name AS module_title,
                           f.slug AS feature_slug
                      FROM client_addons ca
                      JOIN features f ON f.id = ca.feature_id
                     WHERE ca.status = 'active'
                       AND ca.expires_at > NOW()
                       AND ca.expires_at <= NOW() + INTERVAL '{days} days'
                       AND ca.{flag} = FALSE
                    """
                )
            except Exception as e:
                # Миграция 276 не накатана — не роняем весь beat.
                logger.info("Уведомления об истечении модулей пропущены: %r", e)
                return {"sent": 0}

            for r in rows:
                # Есть ли у клиента непрошедшие события этого типа — от этого
                # зависит, насколько срочно продлевать (и текст сообщения).
                has_events = False
                if r["feature_slug"] in ("conference", "tournaments"):
                    module_slug = "conference" if r["feature_slug"] == "conference" else "turnir"
                    has_events = bool(await db.fetchval(
                        """
                        SELECT 1
                          FROM events e
                          JOIN event_owners eo ON eo.event_id = e.id
                                              AND eo.status = 'accepted'
                         WHERE eo.client_id = $1
                           AND e.module_slug = $2
                           AND e.status IN ('published', 'draft')
                           AND (e.end_at IS NULL OR e.end_at > NOW())
                         LIMIT 1
                        """,
                        r["client_id"], module_slug,
                    ))

                text = _message(r["module_title"], days, r["expires_at"], has_events)
                try:
                    from app.services.channels import notify_organizer_all_channels
                    await notify_organizer_all_channels(r["client_id"], text, db)
                except Exception as e:
                    logger.warning("Уведомление о модуле клиенту %s не ушло: %r",
                                   r["client_id"], e)
                    continue

                # Флаг ставим даже если каналы не настроены: иначе таск будет
                # пытаться каждый час до самого истечения.
                await db.execute(
                    f"UPDATE client_addons SET {flag} = TRUE WHERE id = $1", r["id"]
                )
                sent += 1

    return {"sent": sent}


@shared_task(name="app.tasks.addon_expiry.notify_expiring_addons")
def notify_expiring_addons():
    """Раз в час: предупредить клиентов об истечении купленных модулей."""
    result = _run_async(_notify_async())
    if result.get("sent"):
        logger.info("Уведомления об истечении модулей: %s", result)
    return result
