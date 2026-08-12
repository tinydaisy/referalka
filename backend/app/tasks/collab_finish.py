"""Автозавершение коллаб-событий после последнего эфира программы.

Зачем. Рейтинг за коллабу (Win-Win коэффициент) записывается в
`hub_collab_history` ТОЛЬКО в момент перехода события в статус `ended`
(`record_collab_history` из `update_event`). Раньше статус ставился
исключительно руками — переключателем в карточке события. Если организаторы
кнопку не нажимали, вклад не начислялся НИКОГДА: коллаба прошла, люди
приведены, а в Хабе по-прежнему «0 коллабов».

Правило (решение владельца, 2026-08-06): **событие считается завершённым
после последнего эфира из программы**.

Конец программы = `MAX(conf_days.day_date + close_time)`. То же выражение, что
в [webinar_room.py](../api/modules/webinar_room.py) `upcoming-events` — держим
одинаковым, иначе «прошедшее» в одном месте разойдётся с «прошедшим» в другом.
`close_time` пуст → берём 23:59 (день считается закрытым к полуночи).

⚠️ Программы нет (`conf_days` пуст) → падаем на `events.end_at`. Если и его
нет — событие НЕ трогаем: когда оно закончилось, неизвестно, а завершить чужую
коллабу «на глазок» хуже, чем не завершить.

⚠️ Только `is_collab` и только `status='published'`. Обычные мероприятия и
конференции автозавершением не трогаем — там завершение ничего не начисляет,
и менять их привычное поведение задачи не было.
"""
import asyncio
import logging

from celery import shared_task

from app.database import get_pool

logger = logging.getLogger(__name__)


async def _finish_due_collabs() -> int:
    """Найти коллабы, у которых прошёл последний эфир, и завершить их."""
    from app.services.collab_history import record_collab_history

    pool = await get_pool()
    if not pool:
        return 0
    finished = 0
    async with pool.acquire() as db:
        rows = await db.fetch(
            """
            WITH ev AS (
              SELECT e.id,
                     e.title,
                     (SELECT MAX((cd.day_date::timestamp
                                  + COALESCE(NULLIF(cd.close_time,''),'23:59')::time))
                        FROM conf_days cd WHERE cd.event_id = e.id) AS conf_end,
                     e.end_at,
                     (SELECT count(*) FROM event_owners eo
                       WHERE eo.event_id = e.id AND eo.status = 'accepted') AS owners_count
                FROM events e
               WHERE e.is_collab = TRUE
                 AND e.status = 'published'
            )
            SELECT id, title, owners_count
              FROM ev
             -- Момент окончания известен И уже прошёл (сравниваем по МСК —
             -- время программы хранится строкой "HH:MM" и означает МСК).
             WHERE COALESCE(conf_end, end_at) IS NOT NULL
               AND COALESCE(conf_end, end_at) < (NOW() AT TIME ZONE 'Europe/Moscow')
            """
        )
        for r in rows:
            event_id = r["id"]
            try:
                # Статус и запись истории — в ОДНОЙ транзакции: иначе событие
                # могло бы стать `ended` без начисленного вклада, и повторно
                # оно бы уже не попало в выборку (фильтр по 'published').
                #
                # ⚠️ `record_collab_history` глушит свои ошибки и возвращает 0 —
                # исключение до транзакции не долетит, поэтому проверяем результат
                # ЯВНО и откатываемся сами. Иначе коллаба тихо закрылась бы без
                # рейтинга, и починить это можно было бы только руками.
                async with db.transaction():
                    await db.execute(
                        "UPDATE events SET status='ended' WHERE id=$1 AND status='published'",
                        event_id,
                    )
                    written = await record_collab_history(db, event_id)
                    # 0 законен, когда организатор ОДИН (коллабы по факту нет) —
                    # такое событие просто завершаем без записи истории.
                    if not written and int(r["owners_count"] or 0) >= 2:
                        raise RuntimeError(
                            "история коллабы не записана — откат, статус остаётся published"
                        )
                finished += 1
                logger.info(
                    "collab_finish: event %s (%s) → ended, история записана",
                    event_id, (r["title"] or "")[:40],
                )
            except Exception:
                logger.exception("collab_finish: не удалось завершить событие %s", event_id)
    return finished


@shared_task(name="app.tasks.collab_finish.finish_ended_collabs")
def finish_ended_collabs():
    """Celery-обёртка. Раз в час: завершить коллабы, у которых прошёл эфир."""
    try:
        n = asyncio.run(_finish_due_collabs())
        if n:
            logger.info("collab_finish: завершено коллаб — %s", n)
        return n
    except Exception:
        logger.exception("collab_finish: задача упала")
        return 0
