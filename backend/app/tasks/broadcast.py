"""
Рассыльщик PLUSSON.

Celery Beat каждую минуту вызывает check_and_send_broadcasts.
Она находит рассылки у которых fire_at <= NOW() и status = 'pending',
и запускает send_broadcast для каждой.

Текст, фото и кнопка собираются через build_message_content из message_builder —
та же функция что используется в превью.
"""
import asyncio
import asyncpg
import httpx
import logging
from zoneinfo import ZoneInfo
from app.services.message_builder import build_message_content, send_telegram_message
from app.celery_app import celery
from app.config import settings

logger = logging.getLogger(__name__)


def get_db_url() -> str:
    return settings.database_url


async def _get_conn():
    return await asyncpg.connect(get_db_url())


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ─────────────────────────────────────────
# Задача: проверить расписание и запустить рассылки
# ─────────────────────────────────────────
@celery.task(name="app.tasks.broadcast.check_and_send_broadcasts")
def check_and_send_broadcasts():
    run_async(_check_and_send())


async def _check_and_send():
    conn = await _get_conn()
    try:
        schedules = await conn.fetch(
            """
            SELECT id FROM broadcast_schedules
            WHERE fire_at <= NOW() AND status = 'pending'
            ORDER BY fire_at
            """
        )
        for s in schedules:
            await conn.execute(
                "UPDATE broadcast_schedules SET status='running', started_at=NOW() WHERE id=$1",
                s["id"]
            )
            send_broadcast.delay(s["id"])
    finally:
        await conn.close()


# ─────────────────────────────────────────
# Задача: отправить одну рассылку
# ─────────────────────────────────────────
@celery.task(name="app.tasks.broadcast.send_broadcast")
def send_broadcast(schedule_id: int):
    run_async(_send_broadcast(schedule_id))


async def _send_broadcast(schedule_id: int):
    conn = await _get_conn()
    try:
        schedule = await conn.fetchrow(
            """
            SELECT bs.*, e.client_id,
                   COALESCE(bs.snapshot_text,     bt.text)        as tmpl_text,
                   COALESCE(bs.snapshot_photo,    bt.photo_url)   as tmpl_photo,
                   COALESCE(bs.snapshot_btn_text, bt.button_text) as tmpl_btn_text,
                   COALESCE(bs.snapshot_btn_url,  bt.button_url)  as tmpl_btn_url,
                   COALESCE(bs.audience_include, 'all_event') as audience_include,
                   COALESCE(bs.audience_exclude, 'none') as audience_exclude
            FROM broadcast_schedules bs
            JOIN events e ON e.id = bs.event_id
            LEFT JOIN broadcast_templates bt ON bt.id = bs.template_id
            WHERE bs.id = $1
            """,
            schedule_id
        )
        if not schedule:
            return

        event_id = schedule["event_id"]
        tpl_type = schedule.get("type", "")

        # Токен бота
        bot_token = await conn.fetchval(
            "SELECT bot_token FROM clients WHERE id = $1", schedule["client_id"]
        )
        if not bot_token:
            bot_token = settings.telegram_bot_token
        if not bot_token:
            await conn.execute(
                "UPDATE broadcast_schedules SET status='cancelled', error_log=$1, finished_at=NOW() WHERE id=$2",
                "Нет токена бота", schedule_id
            )
            return

        # Часовой пояс клиента
        client_row = await conn.fetchrow("SELECT timezone FROM clients WHERE id=$1", schedule["client_id"])
        tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")

        # Формируем сообщение — единая функция, та же что в превью
        content = await build_message_content(
            conn=conn,
            tpl_type=tpl_type,
            tmpl_text=schedule["tmpl_text"] or "",
            photo_url=schedule["tmpl_photo"],
            btn_text=schedule["tmpl_btn_text"],
            btn_url=schedule["tmpl_btn_url"] or "",
            event_id=event_id,
            session_id=schedule.get("session_id"),
            fire_at=schedule["fire_at"],
            tz=tz,
        )

        text = content["text"]
        photo_url = content["photo"]
        button_text = content["button_text"]
        button_url = content["button_url"]

        # Аудитория
        final_ids = await _build_audience(conn, schedule)
        if schedule["is_test"]:
            tids = await conn.fetchval(
                "SELECT test_telegram_ids FROM clients WHERE id=$1", schedule["client_id"]
            )
            test_ids = {str(t) for t in (tids or [])}
            final_ids = final_ids & test_ids

        # Отправляем
        sent = 0
        async with httpx.AsyncClient(timeout=10) as http_client:
            for tg_id in final_ids:
                success, tg_error = await send_telegram_message(
                    http_client, bot_token, tg_id, text, photo_url, button_text, button_url
                )
                await conn.execute(
                    """
                    INSERT INTO broadcast_log (schedule_id, platform_user_id, status, error, sent_at)
                    SELECT $1, pu.id, $2, $3, NOW()
                    FROM platform_users pu
                    WHERE pu.platform_user_id = $4 AND pu.client_id = $5
                    """,
                    schedule_id,
                    "sent" if success else "failed",
                    tg_error or None,
                    tg_id,
                    schedule["client_id"]
                )
                if success:
                    sent += 1

        # Отправка копии в дополнительные чаты (telegram_chat_ids из настроек конференции)
        if not schedule["is_test"]:
            chat_ids_row = await conn.fetchrow(
                "SELECT telegram_chat_ids FROM conf_conferences WHERE event_id=$1",
                event_id
            )
            if chat_ids_row and chat_ids_row["telegram_chat_ids"]:
                extra_ids = [c.strip() for c in chat_ids_row["telegram_chat_ids"].split(",") if c.strip()]
                async with httpx.AsyncClient(timeout=10) as http_extra:
                    for cid in extra_ids:
                        await send_telegram_message(
                            http_extra, bot_token, cid, text, photo_url, button_text, button_url
                        )

        await conn.execute(
            "UPDATE broadcast_schedules SET status='done', finished_at=NOW(), recipients_sent=$1 WHERE id=$2",
            sent, schedule_id
        )
        logger.info(f"Рассылка {schedule_id} завершена: отправлено {sent} сообщений")

    except Exception as e:
        logger.error(f"Ошибка рассылки {schedule_id}: {e}")
        await conn.execute(
            "UPDATE broadcast_schedules SET status='cancelled', error_log=$1, finished_at=NOW() WHERE id=$2",
            str(e), schedule_id
        )
    finally:
        await conn.close()


async def _build_audience(conn, schedule) -> set:
    aud_include = schedule["audience_include"] or "all_event"
    aud_exclude = schedule["audience_exclude"] or "none"
    event_id = schedule["event_id"]
    client_id = schedule["client_id"]

    if aud_include == "all_client":
        rows = await conn.fetch(
            "SELECT pu.platform_user_id FROM platform_users pu WHERE pu.client_id=$1 AND pu.is_unsubscribed=FALSE AND pu.platform='telegram'",
            client_id
        )
    elif aud_include == "registered_event":
        rows = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.id = ep.platform_user_id
            WHERE ep.event_id=$1 AND ep.is_registered=TRUE AND pu.is_unsubscribed=FALSE AND pu.platform='telegram'
            """,
            event_id
        )
    else:
        rows = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.id = ep.platform_user_id
            WHERE ep.event_id=$1 AND pu.is_unsubscribed=FALSE AND pu.platform='telegram'
            """,
            event_id
        )
    include_ids = {r["platform_user_id"] for r in rows}

    exclude_ids: set = set()
    if aud_exclude == "registered_event":
        ex = await conn.fetch(
            "SELECT pu.platform_user_id FROM event_participants ep JOIN platform_users pu ON pu.id=ep.platform_user_id WHERE ep.event_id=$1 AND ep.is_registered=TRUE AND pu.platform='telegram'",
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}
    elif aud_exclude == "unregistered_event":
        ex = await conn.fetch(
            "SELECT pu.platform_user_id FROM event_participants ep JOIN platform_users pu ON pu.id=ep.platform_user_id WHERE ep.event_id=$1 AND ep.is_registered=FALSE AND pu.platform='telegram'",
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}
    elif aud_exclude == "all_event":
        ex = await conn.fetch(
            "SELECT pu.platform_user_id FROM event_participants ep JOIN platform_users pu ON pu.id=ep.platform_user_id WHERE ep.event_id=$1 AND pu.platform='telegram'",
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}

    return include_ids - exclude_ids
