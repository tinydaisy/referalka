"""
Celery-задача для отправки Текста 3 воронки лид-магнита через 30 минут после Текста 2.

Задача шедулится в funnel_service.run_check_subscription через apply_async(countdown=30*60).
"""
import asyncio
import logging

import asyncpg

from app.celery_app import celery
from app.config import settings

log = logging.getLogger(__name__)


# ⚠️ Celery вызывает task много раз, и каждый вызов создаёт НОВЫЙ event loop.
# Глобальный get_pool() из app.database для этого не годится: он привязан к
# loop первого вызова, а из чужого loop его соединения падают с «another
# operation is in progress» / «attached to a different loop» — задача умирает,
# и человек НЕ получает третье письмо воронки. За две недели так потерялось 45
# писем из 56 (найдено 2026-08-17, копилось с июня).
# Поэтому подключаемся одиночным asyncpg.connect() — как в tasks/nurture.py и
# tasks/broadcast.py. **Тот же запрет действует на любую новую Celery-задачу.**
def _run_async(coro):
    """Создаёт новый event loop, выполняет корутину и закрывает loop.
    Безопасно для Celery — каждый task получает свежий loop."""
    # ⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но НЕ делает
    # его текущим. Библиотеки внутри зовут asyncio.get_event_loop() и получают
    # ЗАКРЫТЫЙ цикл предыдущей задачи того же воркера → RuntimeError('Event loop
    # is closed'). Так молча терялись записи вебинаров и Текст 3 воронок.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@celery.task(name="app.tasks.funnel.send_text_3")
def send_text_3(run_id: int) -> None:
    """Запускает асинхронный send_text_3 в своём event loop."""
    _run_async(_run(run_id))


async def _run(run_id: int) -> None:
    from app.services.funnel_service import send_text_3 as send_text_3_async
    db = await asyncpg.connect(settings.database_url)
    try:
        await send_text_3_async(run_id, db)
    except Exception as e:
        log.exception("send_text_3 failed for run %s: %s", run_id, e)
    finally:
        try:
            await db.close()
        except Exception:
            pass
