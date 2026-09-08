"""Рассылка новости платформы: почта клиентов и личка @pluson_bot.

⚠️ Через очередь, а не прямо из HTTP-запроса: получателей сотни, письма идут с
паузой, и запрос из браузера отвалился бы по таймауту, оставив рассылку
наполовину отправленной.

⚠️ Задачи ОДНОРАЗОВЫЕ (по кнопке в админке), в beat_schedule не ставятся.
"""
import asyncio
import logging

import asyncpg
from celery import shared_task

from app.config import settings

log = logging.getLogger(__name__)


def _run(coro):
    """⚠️ Свой цикл + set_event_loop обязательны: new_event_loop() создаёт
    цикл, но не делает его текущим, и библиотеки внутри через
    asyncio.get_event_loop() получают ЗАКРЫТЫЙ цикл предыдущей задачи того же
    воркера → RuntimeError('Event loop is closed'). На этом уже молча терялись
    записи эфиров и тексты воронок."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


async def _send_email_async(news_id: int) -> dict:
    from app.services.platform_news import send_news_email
    db = await asyncpg.connect(settings.database_url)
    try:
        return await send_news_email(db, news_id)
    finally:
        await db.close()


async def _send_bot_async(news_id: int) -> dict:
    from app.services.platform_news import send_news_bot
    db = await asyncpg.connect(settings.database_url)
    try:
        return await send_news_bot(db, news_id)
    finally:
        await db.close()


@shared_task(name="app.tasks.platform_news.send_news_email_task")
def send_news_email_task(news_id: int) -> dict:
    """Письмо с новостью всем клиентам, кроме отписавшихся."""
    try:
        return _run(_send_email_async(int(news_id)))
    except Exception as e:  # noqa: BLE001
        log.exception("news email task failed (news %s): %s", news_id, e)
        return {"sent": 0, "failed": 0, "error": str(e)}


@shared_task(name="app.tasks.platform_news.send_news_bot_task")
def send_news_bot_task(news_id: int) -> dict:
    """Сообщение с новостью в личку клиентам через @pluson_bot."""
    try:
        return _run(_send_bot_async(int(news_id)))
    except Exception as e:  # noqa: BLE001
        log.exception("news bot task failed (news %s): %s", news_id, e)
        return {"sent": 0, "failed": 0, "error": str(e)}
