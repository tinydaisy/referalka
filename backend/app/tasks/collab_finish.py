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

import asyncpg
from celery import shared_task

from app.config import settings

logger = logging.getLogger(__name__)


async def _notify_owners(db, event_id: int, text: str) -> None:
    """Уведомить ВСЕХ организаторов коллабы. Сбой одного канала не мешает остальным."""
    from app.services.channels import notify_organizer_all_channels
    try:
        owners = await db.fetch(
            "SELECT client_id FROM event_owners WHERE event_id=$1 AND status='accepted'",
            event_id,
        )
    except Exception:
        logger.exception("collab_finish: не удалось получить организаторов события %s", event_id)
        return
    for o in owners:
        try:
            await notify_organizer_all_channels(int(o["client_id"]), text, db, text_plain=text)
        except Exception:
            logger.exception(
                "collab_finish: уведомление организатору %s (событие %s) не ушло",
                o["client_id"], event_id,
            )


async def _warn_upcoming_finish(db) -> int:
    """Предупредить организаторов за сутки до автозавершения.

    ⚠️ Предупреждаем ДО, а не после: узнать, что событие уже завершено и учтено
    в рейтинге, — бесполезно, поправить дату человек уже не сможет. За сутки
    он успевает вмешаться, если просто забыл сдвинуть дату.

    Отметка о посланном предупреждении — `events.collab_finish_warned_at`:
    без неё письмо уходило бы каждый час, пока идут эти сутки.
    """
    rows = await db.fetch(
        """
        WITH ev AS (
          SELECT e.id, e.title,
                 (SELECT MAX((cd.day_date::timestamp
                              + COALESCE(NULLIF(cd.close_time,''),'23:59')::time))
                    FROM conf_days cd WHERE cd.event_id = e.id) AS conf_end,
                 e.end_at
            FROM events e
           WHERE e.is_collab = TRUE
             AND e.status = 'published'
             AND e.collab_finish_warned_at IS NULL
        )
        SELECT id, title
          FROM ev
         WHERE COALESCE(conf_end, end_at) IS NOT NULL
           -- Окончание ещё впереди, но наступит в ближайшие сутки.
           AND COALESCE(conf_end, end_at) > (NOW() AT TIME ZONE 'Europe/Moscow')
           AND COALESCE(conf_end, end_at) < (NOW() AT TIME ZONE 'Europe/Moscow') + INTERVAL '1 day'
        """
    )
    sent = 0
    for r in rows:
        await _notify_owners(
            db, r["id"],
            f"⏳ Коллаба «{r['title']}» завершится завтра\n\n"
            "После окончания событие получит статус «Завершена», а вклад каждого "
            "организатора будет записан в рейтинг Коллабораторной.\n\n"
            "Если дата указана неверно — поправьте её сейчас, в карточке события.",
        )
        try:
            await db.execute(
                "UPDATE events SET collab_finish_warned_at = NOW() WHERE id=$1", r["id"]
            )
            sent += 1
        except Exception:
            logger.exception("collab_finish: не отмечено предупреждение по событию %s", r["id"])
    return sent


async def _finish_due_collabs(db) -> int:
    """Найти коллабы, у которых прошёл последний эфир, и завершить их.

    ⚠️ Соединение приходит СНАРУЖИ (одиночное asyncpg.connect из _run_once),
    а не берётся из глобального пула: пул привязан к event loop первого вызова
    и в Celery падает из нового loop — см. tasks/funnel.py.
    """
    from app.services.collab_history import record_collab_history

    finished = 0
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
           -- ⚠️ НЕ завершаем событие, где среди участников только САМИ
           -- организаторы (их собственные контакты через self_collaborator).
           -- Это верный признак, что человек ещё ПРОВЕРЯЕТ систему, а не
           -- провёл коллаборацию: он открыл своё событие сам, дата давно
           -- прошла — и автозавершение записывало ему коллаборацию, которой
           -- не было. Порога «сколько нужно участников» здесь намеренно НЕТ:
           -- он бил бы по новичкам, у которых первая коллаба маленькая.
           AND EXISTS (
                 SELECT 1
                   FROM event_participants p
                  WHERE p.event_id = ev.id
                    AND p.contact_id IS NOT NULL
                    AND p.contact_id NOT IN (
                          SELECT co.contact_id
                            FROM event_owners eo
                            JOIN clients cl ON cl.id = eo.client_id
                            JOIN collaborators co ON co.id = cl.self_collaborator_id
                           WHERE eo.event_id = ev.id
                             AND eo.status = 'accepted'
                             AND co.contact_id IS NOT NULL
                    )
               )
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
            await _notify_owners(
                db, event_id,
                f"🏁 Коллаба «{r['title']}» завершена\n\n"
                "Событие прошло, вклад каждого организатора записан в рейтинг "
                "Коллабораторной.\n\n"
                "Чтобы провести ещё одну — скопируйте это событие: "
                "у копии будут свои даты, а рейтинг за прошедшую останется как есть.",
            )
        except Exception:
            logger.exception("collab_finish: не удалось завершить событие %s", event_id)
    return finished


async def _run_once() -> int:
    """Один проход: сперва предупредить тех, кому завершение предстоит, затем завершить.

    ⚠️ Одиночное соединение, НЕ глобальный get_pool(): пул привязан к event loop
    первого вызова и в Celery падает из нового loop — см. tasks/funnel.py.
    """
    db = await asyncpg.connect(settings.database_url)
    try:
        try:
            warned = await _warn_upcoming_finish(db)
            if warned:
                logger.info("collab_finish: предупреждений о завершении — %s", warned)
        except Exception:
            # Предупреждения не должны мешать самому завершению.
            logger.exception("collab_finish: рассылка предупреждений упала")
        return await _finish_due_collabs(db)
    finally:
        try:
            await db.close()
        except Exception:
            pass


def _run_async(coro):
    """Свежий event loop на каждый запуск задачи (см. комментарий в _run_once)."""
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


@shared_task(name="app.tasks.collab_finish.finish_ended_collabs")
def finish_ended_collabs():
    """Celery-обёртка. Раз в час: завершить коллабы, у которых прошёл эфир."""
    try:
        n = _run_async(_run_once())
        if n:
            logger.info("collab_finish: завершено коллаб — %s", n)
        return n
    except Exception:
        logger.exception("collab_finish: задача упала")
        return 0
