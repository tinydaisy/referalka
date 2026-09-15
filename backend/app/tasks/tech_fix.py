"""Ежемесячный фикс тех-специалистам за обслуживание (миграция 391).

Начисляется за каждого ПЛАТЯЩЕГО клиента, закреплённого за специалистом.

⚠️⚠️ ЗАДАЧА ИДЕМПОТЕНТНА ПО БАЗЕ, а не по проверке в коде: уникальный индекс
`uniq_tech_accrual_fix` не даёт второй строки на (специалист, клиент, месяц).
Перезапуск задачи, ручной прогон и двойной тик Celery ничего не задваивают —
а деньги дважды за один месяц это спор с человеком, которому платят.

⚠️ Раз в сутки, а не раз в месяц. Раз в месяц значило бы: задача не отработала в
свой день — фикс потерян до следующего. Ежедневный прогон досчитывает то, чего
ещё нет, и молчит, когда всё начислено.

⚠️ `asyncio.set_event_loop(loop)` обязателен: `new_event_loop()` создаёт цикл, но
НЕ делает его текущим, и библиотеки внутри получают закрытый цикл предыдущей
задачи того же воркера («Event loop is closed»). На этом уже теряли записи
эфиров и тексты воронок.
"""

from __future__ import annotations

import asyncio
import logging

from celery import shared_task

from app.database import get_pool

logger = logging.getLogger(__name__)


@shared_task(name="app.tasks.tech_fix.accrue_monthly_fix")
def accrue_monthly_fix():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_run())
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@shared_task(name="app.tasks.tech_fix.accrue_quarter_bonus")
def accrue_quarter_bonus():
    """Раздача премиального фонда внедренцам по весам их ролей.

    ⚠️ Механика сменилась 15.09.2026: раньше премия считалась по доле доживших
    ступенями, теперь владелец вносит сумму фонда за квартал (процент от прибыли
    компании считается в фин-модели), а платформа делит её по весам.

    ⚠️ Раз в сутки, а не раз в квартал: задача ищет нерозданный фонд и отдаёт
    его, как только он внесён. Раз в квартал значило бы — не отработала в свой
    день, премия потеряна до следующего.

    ⚠️ Фонда нет — задача молча ничего не делает: это нормальное состояние
    между кварталами, а не ошибка.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_run_quarter())
    finally:
        loop.close()
        asyncio.set_event_loop(None)


async def _run_quarter() -> dict:
    from app.services.tech_accruals import accrue_quarter_bonus as _accrue
    pool = await get_pool()
    async with pool.acquire() as db:
        try:
            n = await _accrue(db)
        except Exception as e:                                  # noqa: BLE001
            logger.exception("tech quarter bonus: не начислена: %s", e)
            return {"ok": False, "error": str(e)}
    return {"ok": True, "accrued": n}


async def _run() -> dict:
    from app.services.tech_accruals import accrue_monthly_fix as _accrue

    pool = await get_pool()
    async with pool.acquire() as db:
        try:
            n = await _accrue(db)
        except Exception as e:                                  # noqa: BLE001
            # Сбой начисления не должен ронять расписание Celery целиком.
            logger.exception("tech fix: не начислен: %s", e)
            return {"ok": False, "error": str(e)}
    return {"ok": True, "accrued": n}
