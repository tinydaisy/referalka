"""Закрытие зависших эфиров (Celery, раз в 10 минут).

Зачем. Эфир завершает ведущий кнопкой «Завершить». Если у него в этот момент
оборвался интернет или он просто закрыл вкладку — сессия остаётся открытой
навсегда: у неё есть время начала и нет времени окончания.

Чем это плохо:
  • статистика эфира не считается — он «всё ещё идёт»;
  • запись не собирается в готовый файл;
  • деплой заблокирован: он не начинается, пока идёт эфир, а этот не кончится
    никогда.

Мы точно знаем, идёт ли поток: MediaMTX сам сообщает нам, когда видеокодер
подключился и когда отключился (`webinar_rooms.stream_active`). Значит зависшую
сессию видно однозначно — поток давно не идёт, а сессия числится живой.

⚠️ Ждём целый час, а не пять минут. Обрыв связи у ведущего — обычное дело:
интернет моргнул, видеокодер переподключается, эфир продолжается. Закрыть
сессию рано значит оборвать живой эфир на ровном месте — это хуже, чем
подождать. Час выбран как заведомо больший, чем любой обрыв связи.
"""
from __future__ import annotations

import asyncio
import logging

import asyncpg

from app.celery_app import celery
from app.config import settings

_log = logging.getLogger(__name__)

# Сколько поток должен отсутствовать, чтобы считать эфир брошенным.
STUCK_AFTER_MIN = 60


def _run_async(coro):
    # ⚠️ set_event_loop ОБЯЗАТЕЛЕН: new_event_loop() создаёт цикл, но НЕ делает
    # его текущим. Библиотеки внутри зовут get_event_loop() и получают ЗАКРЫТЫЙ
    # цикл предыдущей задачи того же воркера → RuntimeError('Event loop is
    # closed'). Так молча терялись записи эфиров и Текст 3 воронок.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(None)


async def _close_stuck() -> int:
    conn = await asyncpg.connect(settings.database_url)
    try:
        rows = await conn.fetch(
            f"""SELECT ws.id AS session_id, ws.started_at, wr.id AS room_id,
                       wr.day_number, e.id AS event_id, e.title AS event_title
                  FROM webinar_sessions ws
                  JOIN webinar_rooms wr ON wr.id = ws.room_id
                  JOIN events e ON e.id = wr.event_id
                 WHERE ws.started_at IS NOT NULL
                   AND ws.ended_at IS NULL
                   AND COALESCE(wr.stream_active, FALSE) = FALSE
                   AND ws.started_at < NOW() - interval '{STUCK_AFTER_MIN} minutes'"""
        )
        if not rows:
            return 0

        for r in rows:
            # ⚠️ Закрываем ТЕМ ЖЕ способом, что и кнопка «Завершить эфир», чтобы
            # дальше всё пошло обычным путём: запись соберётся, статистика
            # посчитается. Отдельной ветки «аварийное завершение» не заводим —
            # она разъедется с обычной.
            await conn.execute(
                "UPDATE webinar_sessions SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL",
                r["session_id"],
            )
            await conn.execute(
                "UPDATE webinar_rooms SET status='ended', ended_at=NOW(), "
                "current_session_id=NULL WHERE id=$1",
                r["room_id"],
            )
            _log.warning(
                "Зависший эфир закрыт: событие %s «%s», день %s, шёл с %s",
                r["event_id"], r["event_title"], r["day_number"], r["started_at"],
            )
            await _notify(conn, r)

        return len(rows)
    finally:
        await conn.close()


async def _notify(conn, r) -> None:
    """Сообщаем организатору и владельцу платформы.

    ⚠️ Молча закрывать нельзя: для организатора это выглядит как «эфир сам
    пропал из кабинета». Он должен понимать, что произошло и что запись цела.

    ⚠️ ПОЧТА ОБЯЗАТЕЛЬНА, а каналы в мессенджерах — дополнение. Канал уведомлений
    клиент заводит руками, и у большинства он пустой: сообщение бы просто никуда
    не ушло. Почта есть у каждого — она из регистрации.
    """
    when = r["started_at"].strftime("%d.%m.%Y %H:%M") if r["started_at"] else "—"
    text = (
        f"⏹ Эфир завершён автоматически\n\n"
        f"Событие: <b>{r['event_title']}</b> (день {r['day_number']})\n"
        f"Начался: {when} МСК\n\n"
        f"Трансляция не поступала больше часа, поэтому мы закрыли эфир сами — "
        f"похоже, кнопку «Завершить эфир» нажать не успели.\n\n"
        f"Запись и статистика на месте, они в карточке события."
    )

    owner = await conn.fetchval(
        "SELECT client_id FROM event_owners "
        "WHERE event_id = $1 AND status = 'accepted' ORDER BY id LIMIT 1",
        r["event_id"],
    )

    # Организатору — письмо (главное) и каналы уведомлений (если настроены).
    if owner:
        await _send_email(
            conn, owner,
            subject=f"Эфир «{r['event_title']}» завершён автоматически",
            body_text=(
                f"Событие: {r['event_title']} (день {r['day_number']})\n"
                f"Эфир начался: {when} МСК\n\n"
                f"Трансляция не поступала больше часа, поэтому мы закрыли эфир сами — "
                f"похоже, кнопку «Завершить эфир» нажать не успели.\n\n"
                f"Запись и статистика на месте — они в карточке события, "
                f"на вкладке «Вебинары».\n\n"
                f"— iViSiON: ПЛЮСОН"
            ),
        )
        try:
            from app.services.channels import notify_organizer_all_channels
            await notify_organizer_all_channels(owner, text, conn)
        except Exception:
            _log.exception("Не смогли сообщить организатору в мессенджер")

    # Владельцу платформы — в служебную группу. Это признак того, что у кого-то
    # рвётся связь или ведущие не знают про кнопку «Завершить».
    try:
        from app.services.channels import notify_organizer_all_channels

        svc = await conn.fetchval(
            "SELECT id FROM clients WHERE is_system_service = TRUE LIMIT 1"
        )
        if svc:
            await notify_organizer_all_channels(
                svc,
                f"⏹ Автозавершение эфира\n\n"
                f"Клиент: событие #{r['event_id']} «{r['event_title']}»\n"
                f"Эфир шёл с {when} МСК, поток не поступал больше часа.",
                conn,
            )
    except Exception:
        _log.exception("Не смогли сообщить владельцу о зависшем эфире")


async def _send_email(conn, client_id: int, *, subject: str, body_text: str) -> None:
    """Письмо клиенту через системный почтовый канал ПЛЮСОНа."""
    try:
        client = await conn.fetchrow(
            "SELECT name, email FROM clients WHERE id = $1", client_id
        )
        if not client or not client["email"]:
            return

        ch = await conn.fetchrow(
            """SELECT ch.*, cc.id AS client_channel_id
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1
                  AND ch.platform_slug = 'email'
                  AND ch.is_system = TRUE
                LIMIT 1""",
            client_id,
        )
        if not ch:
            return

        from app.services.email_sender import EmailSender
        from app.services.unsubscribe_token import make_email_unsubscribe_token

        channel_dict = dict(ch)
        channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"

        name = (client["name"] or "").strip()
        greeting = f"Здравствуйте, {name}!\n\n" if name else "Здравствуйте!\n\n"

        EmailSender().send(
            channel=channel_dict,
            client_brand_name="iViSiON: ПЛЮСОН",
            to_email=client["email"],
            subject=subject,
            body_text=greeting + body_text,
            unsubscribe_token=make_email_unsubscribe_token(
                client_id=client_id, contact_id=0,
                client_channel_id=ch["client_channel_id"],
            ),
        )
    except Exception:
        _log.exception("Не смогли отправить письмо о зависшем эфире (клиент %s)", client_id)


@celery.task(name="app.tasks.webinar_stuck.close_stuck_sessions")
def close_stuck_sessions():
    n = _run_async(_close_stuck())
    if n:
        _log.warning("Закрыто зависших эфиров: %s", n)
    return {"closed": n}
