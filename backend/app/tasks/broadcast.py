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
        # Watchdog: сбрасываем задачи зависшие в running > 30 минут обратно в pending
        stale = await conn.fetch(
            """
            SELECT id FROM broadcast_schedules
            WHERE status = 'running'
            AND started_at < NOW() - INTERVAL '10 minutes'
            """
        )
        for s in stale:
            logger.warning(f"Watchdog: рассылка {s['id']} зависла в running > 30 мин, сбрасываем в pending")
            await conn.execute(
                "UPDATE broadcast_schedules SET status='pending', started_at=NULL WHERE id=$1",
                s["id"]
            )

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
            SELECT bs.*, COALESCE(e.client_id, bs.client_id) AS client_id,
                   COALESCE(bs.audience_include, 'all_event') as audience_include,
                   COALESCE(bs.audience_exclude, 'none') as audience_exclude
            FROM broadcast_schedules bs
            LEFT JOIN events e ON e.id = bs.event_id
            WHERE bs.id = $1
            """,
            schedule_id
        )
        if not schedule:
            return

        event_id = schedule["event_id"]
        tpl_type = schedule.get("type", "")

        # Читаем шаблон отдельным свежим запросом — максимально близко к отправке,
        # чтобы правки шаблона применились даже если очередь уже активирована
        tmpl = await conn.fetchrow(
            "SELECT text, photo_url, button_text, button_url FROM broadcast_templates WHERE id=$1",
            schedule["template_id"]
        ) if schedule["template_id"] else None
        tmpl_text_val  = tmpl["text"]         if tmpl else ""
        tmpl_photo_val = tmpl["photo_url"]    if tmpl else None
        tmpl_btn_text_val = tmpl["button_text"] if tmpl else None
        tmpl_btn_url_val  = tmpl["button_url"]  if tmpl else ""

        # Токен бота для тех получателей, у кого нет привязки к конкретному каналу
        # (легаси-контакты без записи в platform_user_channels). Берём главный
        # активный канал клиента; если такого нет — любой канал клиента с токеном;
        # если и таких нет — глобальный @pluson_bot.
        from app.services.channels import (
            get_client_telegram_token,
            get_telegram_send_targets,
            mark_unsubscribed_by_tg_id,
        )
        default_bot_token = await get_client_telegram_token(schedule["client_id"], conn)
        if not default_bot_token:
            default_bot_token = await conn.fetchval(
                """SELECT bot_token FROM channels
                    WHERE client_id = $1 AND platform_slug = 'telegram'
                      AND bot_token IS NOT NULL AND bot_token <> ''
                    ORDER BY is_active DESC, id ASC LIMIT 1""",
                schedule["client_id"],
            )
        if not default_bot_token:
            default_bot_token = settings.telegram_bot_token
        if not default_bot_token:
            await conn.execute(
                "UPDATE broadcast_schedules SET status='cancelled', error_log=$1, finished_at=NOW() WHERE id=$2",
                "Нет токена бота", schedule_id
            )
            return

        # Часовой пояс клиента + настройка скорости рассылки
        client_row = await conn.fetchrow(
            "SELECT timezone, broadcast_concurrency FROM clients WHERE id=$1",
            schedule["client_id"]
        )
        tz = ZoneInfo((client_row["timezone"] or "Europe/Moscow") if client_row else "Europe/Moscow")
        concurrency = int((client_row["broadcast_concurrency"] if client_row else 30) or 30)
        if concurrency < 1: concurrency = 1
        if concurrency > 100: concurrency = 100

        # Для type='custom' — берём из snapshot (свой текст / фото / кнопки)
        snap = None
        if tpl_type == "custom":
            snap_buttons = schedule.get("snapshot_buttons")
            if isinstance(snap_buttons, str):
                try:
                    import json as _json
                    snap_buttons = _json.loads(snap_buttons)
                except Exception:
                    snap_buttons = []
            snap = {
                "text": schedule.get("snapshot_text") or "",
                "photo": schedule.get("snapshot_photo"),
                "buttons": snap_buttons or [],
            }

        # Формируем сообщение — единая функция, та же что в превью
        content = await build_message_content(
            conn=conn,
            tpl_type=tpl_type,
            tmpl_text=tmpl_text_val or "",
            photo_url=tmpl_photo_val,
            btn_text=tmpl_btn_text_val,
            btn_url=tmpl_btn_url_val or "",
            event_id=event_id,
            session_id=schedule.get("session_id"),
            fire_at=schedule["fire_at"],
            tz=tz,
            template_id=schedule.get("template_id"),
            snapshot=snap,
        )

        text = content["text"]
        photo_url = content["photo"]
        button_text = content.get("button_text")
        button_url = content.get("button_url")
        buttons = content.get("buttons") or None

        # Аудитория
        final_ids = await _build_audience(conn, schedule)
        if schedule["is_test"]:
            tids = await conn.fetchval(
                "SELECT test_telegram_ids FROM clients WHERE id=$1", schedule["client_id"]
            )
            test_ids = {str(t) for t in (tids or [])}
            final_ids = final_ids & test_ids

        # Идемпотентность: исключаем тех кому уже успешно отправили
        # (защита от дублей при повторном запуске после сбоя)
        already_sent = await conn.fetch(
            """
            SELECT pu.platform_user_id FROM broadcast_log bl
            JOIN platform_users pu ON pu.id = bl.platform_user_id
            WHERE bl.schedule_id = $1 AND bl.status = 'sent'
            """,
            schedule_id
        )
        already_sent_ids = {r["platform_user_id"] for r in already_sent}
        if already_sent_ids:
            logger.info(f"Рассылка {schedule_id}: пропускаем {len(already_sent_ids)} уже получивших")
        final_ids = final_ids - already_sent_ids

        # Если в тексте есть персональные плейсхолдеры — подтягиваем имена получателей
        needs_first_name = "{first_name}" in (text or "")
        name_by_tg: dict[str, str] = {}
        if needs_first_name and final_ids:
            name_rows = await conn.fetch(
                """
                SELECT platform_user_id, COALESCE(NULLIF(first_name, ''), 'друг') AS first_name
                FROM platform_users
                WHERE client_id=$1 AND platform_slug='telegram' AND platform_user_id = ANY($2::text[])
                """,
                schedule["client_id"], list(final_ids)
            )
            name_by_tg = {r["platform_user_id"]: r["first_name"] for r in name_rows}

        # {game_link} — индивидуальная ссылка на вкладку «Игра» события для каждого
        # получателя. Формат: t.me/{бот_клиента_или_pluson}?startapp=ref_pg{slug}_tabgame_pid{ref_code}
        # Подставляется и в text, и в button_url.
        needs_game_link = "{game_link}" in (text or "") or "{game_link}" in (button_url or "")
        game_link_by_tg: dict[str, str] = {}
        event_slug_for_glink = ""
        glink_bot_url = ""
        if needs_game_link:
            ev_row = await conn.fetchrow("SELECT slug FROM events WHERE id=$1", event_id)
            event_slug_for_glink = (ev_row["slug"] if ev_row else "") or ""
            # Бот клиента (VIP) или общий @pluson_bot/pluson
            bot_handle = await conn.fetchval(
                """SELECT REGEXP_REPLACE(handle, '^@', '')
                     FROM channels
                    WHERE client_id=$1 AND platform_slug='telegram'
                      AND is_active=true AND bot_token IS NOT NULL
                    LIMIT 1""",
                schedule["client_id"]
            )
            glink_bot_url = (f"https://t.me/{bot_handle}" if bot_handle
                             else "https://t.me/pluson_bot/pluson")
            if final_ids:
                ref_rows = await conn.fetch(
                    """
                    SELECT pu.platform_user_id, c.ref_code
                      FROM platform_users pu
                      JOIN contacts c ON c.id = pu.contact_id
                     WHERE pu.client_id = $1 AND pu.platform_slug = 'telegram'
                       AND pu.platform_user_id = ANY($2::text[])
                    """,
                    schedule["client_id"], list(final_ids)
                )
                for r in ref_rows:
                    rc = r["ref_code"] or ""
                    game_link_by_tg[r["platform_user_id"]] = (
                        f"{glink_bot_url}?startapp=ref_pg{event_slug_for_glink}_tabgame_pid{rc}"
                    )

        # Карта «через какой канал слать конкретному получателю».
        # Пустая запись ⇒ fallback на default_bot_token (главный/единственный канал клиента).
        target_by_tg = await get_telegram_send_targets(
            schedule["client_id"], list(final_ids), conn
        )

        # Отправляем параллельно (скорость = clients.broadcast_concurrency)
        sent = 0
        sem = asyncio.Semaphore(concurrency)

        async def send_one(tg_id: str, http_client: httpx.AsyncClient):
            async with sem:
                msg_text = text
                msg_btn_url = button_url
                if needs_first_name:
                    msg_text = msg_text.replace("{first_name}", name_by_tg.get(tg_id, "друг"))
                if needs_game_link:
                    glink = game_link_by_tg.get(
                        tg_id,
                        f"{glink_bot_url}?startapp=ref_pg{event_slug_for_glink}_tabgame"
                    )
                    msg_text = msg_text.replace("{game_link}", glink)
                    if msg_btn_url:
                        msg_btn_url = msg_btn_url.replace("{game_link}", glink)
                target = target_by_tg.get(tg_id) or {}
                token = target.get("bot_token") or default_bot_token
                channel_id = target.get("channel_id")
                ok, err = await send_telegram_message(
                    http_client, token, tg_id, msg_text, photo_url, button_text, msg_btn_url,
                    buttons=buttons
                )
                return tg_id, channel_id, (ok, err)

        async with httpx.AsyncClient(timeout=15, limits=httpx.Limits(max_connections=max(concurrency + 20, 50))) as http_client:
            results = await asyncio.gather(*[send_one(tid, http_client) for tid in final_ids])

        # Пишем лог одной пачкой после отправки
        BLOCKED_ERRORS = ("bot was blocked by the user", "user is deactivated", "chat not found", "have no rights to send a message")
        for tg_id, channel_id, (success, tg_error) in results:
            is_blocked = not success and tg_error and any(e in tg_error.lower() for e in BLOCKED_ERRORS)
            await conn.execute(
                """
                INSERT INTO broadcast_log (schedule_id, platform_user_id, status, error, sent_at)
                SELECT $1, pu.id, $2, $3, NOW()
                FROM platform_users pu
                WHERE pu.platform_slug = 'telegram' AND pu.platform_user_id = $4 AND pu.client_id = $5
                """,
                schedule_id,
                "sent" if success else "failed",
                tg_error or None,
                tg_id,
                schedule["client_id"]
            )
            if is_blocked:
                # Помечаем отписавшимся в КОНКРЕТНОМ канале через который слали.
                # Если канала не было (легаси) — отметим в главном.
                await mark_unsubscribed_by_tg_id(
                    schedule["client_id"], tg_id, conn, channel_id=channel_id
                )
            if success:
                sent += 1

        # Отправка копии в дополнительные чаты (telegram_chat_ids из настроек конференции)
        # Эти чаты — служебные группы клиента, шлём через главного бота.
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
                            http_extra, default_bot_token, cid, text, photo_url, button_text, button_url,
                            buttons=buttons
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

    # Подписан = есть хотя бы один не-отписанный telegram-канал клиента,
    # либо записей в platform_user_channels нет вовсе (легаси-контакты).
    # Если человек отписался от ВСЕХ каналов клиента — исключаем.
    SUBSCRIBED_CLAUSE = """
        (
          EXISTS (
            SELECT 1 FROM platform_user_channels puc
            JOIN channels ch ON ch.id = puc.channel_id
            WHERE puc.platform_user_id = pu.id
              AND ch.client_id = pu.client_id
              AND ch.platform_slug = 'telegram'
              AND puc.is_unsubscribed = FALSE
          )
          OR NOT EXISTS (
            SELECT 1 FROM platform_user_channels puc
            JOIN channels ch ON ch.id = puc.channel_id
            WHERE puc.platform_user_id = pu.id
              AND ch.client_id = pu.client_id
              AND ch.platform_slug = 'telegram'
          )
        )
    """

    if aud_include == "all_client":
        rows = await conn.fetch(
            f"SELECT pu.platform_user_id FROM platform_users pu "
            f"WHERE pu.client_id=$1 AND pu.platform_slug='telegram' AND {SUBSCRIBED_CLAUSE}",
            client_id
        )
    elif aud_include == "registered_event":
        rows = await conn.fetch(
            f"""
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug='telegram'
            WHERE ep.event_id=$1 AND ep.is_registered=TRUE AND {SUBSCRIBED_CLAUSE}
            """,
            event_id
        )
    else:
        rows = await conn.fetch(
            f"""
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug='telegram'
            WHERE ep.event_id=$1 AND {SUBSCRIBED_CLAUSE}
            """,
            event_id
        )
    include_ids = {r["platform_user_id"] for r in rows}

    exclude_ids: set = set()
    if aud_exclude == "registered_event":
        ex = await conn.fetch(
            "SELECT pu.platform_user_id FROM event_participants ep "
            "JOIN platform_users pu ON pu.contact_id=ep.contact_id AND pu.platform_slug='telegram' "
            "WHERE ep.event_id=$1 AND ep.is_registered=TRUE",
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}
    elif aud_exclude == "unregistered_event":
        ex = await conn.fetch(
            "SELECT pu.platform_user_id FROM event_participants ep "
            "JOIN platform_users pu ON pu.contact_id=ep.contact_id AND pu.platform_slug='telegram' "
            "WHERE ep.event_id=$1 AND ep.is_registered=FALSE",
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}
    elif aud_exclude == "all_event":
        ex = await conn.fetch(
            "SELECT pu.platform_user_id FROM event_participants ep "
            "JOIN platform_users pu ON pu.contact_id=ep.contact_id AND pu.platform_slug='telegram' "
            "WHERE ep.event_id=$1",
            event_id
        )
        exclude_ids = {r["platform_user_id"] for r in ex}

    return include_ids - exclude_ids
