"""
Celery-задача для отправки Текста 3 воронки лид-магнита через 30 минут после Текста 2.

Задача шедулится в funnel_service.run_check_subscription через apply_async(countdown=30*60).
"""
import asyncio
import logging
from app.celery_app import celery

log = logging.getLogger(__name__)


@celery.task(name="app.tasks.funnel.send_text_3")
def send_text_3(run_id: int) -> None:
    """Запускает асинхронный send_text_3 в loop."""
    asyncio.run(_run(run_id))


async def _run(run_id: int) -> None:
    from app.database import get_pool
    from app.services.funnel_service import send_text_3 as send_text_3_async
    pool = await get_pool()
    try:
        async with pool.acquire() as db:
            await send_text_3_async(run_id, db)
    except Exception as e:
        log.exception("send_text_3 failed for run %s: %s", run_id, e)
