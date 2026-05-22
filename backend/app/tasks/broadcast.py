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

        # Защита от race-condition: подписка могла истечь между планированием и отправкой.
        # Если истекла — паузим запись и выходим (cron expire_overdue делает то же оптом).
        client_id_for_check = schedule["client_id"]
        sub_active = await conn.fetchval(
            """SELECT 1 FROM client_subscriptions
                WHERE client_id = $1 AND status = 'active' AND expires_at > NOW()
                LIMIT 1""",
            client_id_for_check,
        )
        if not sub_active:
            await conn.execute(
                "UPDATE broadcast_schedules SET status = 'paused_subscription_expired' WHERE id = $1",
                schedule_id,
            )
            return

        event_id = schedule["event_id"]
        tpl_type = schedule.get("type", "")

        # Читаем шаблон отдельным свежим запросом — максимально близко к отправке,
        # чтобы правки шаблона применились даже если очередь уже активирована
        tmpl = await conn.fetchrow(
            "SELECT text, photo_url, button_text, button_url, target_channel_ids "
            "FROM broadcast_templates WHERE id=$1",
            schedule["template_id"]
        ) if schedule["template_id"] else None
        tmpl_text_val  = tmpl["text"]         if tmpl else ""
        tmpl_photo_val = tmpl["photo_url"]    if tmpl else None
        tmpl_btn_text_val = tmpl["button_text"] if tmpl else None
        tmpl_btn_url_val  = tmpl["button_url"]  if tmpl else ""

        # Фильтр «Каналы для отправки» (миграция 100). Если в schedule задано
        # явно — используем его. Если NULL и есть шаблон — fallback на target
        # из шаблона. NULL в обоих местах = слать по всем каналам (default,
        # обратная совместимость для всех старых рассылок).
        target_channel_ids = schedule.get("target_channel_ids")
        if target_channel_ids is None and tmpl is not None:
            target_channel_ids = tmpl["target_channel_ids"]
        target_channel_set: set[int] | None = (
            set(target_channel_ids) if target_channel_ids is not None else None
        )

        def _channel_allowed(channel_id: int | None) -> bool:
            """Разрешена ли отправка через данный channel_id с учётом target_channel_set."""
            if target_channel_set is None:
                return True  # NULL = все каналы
            if channel_id is None:
                return False  # клиент явно ограничил — без id не слать
            return channel_id in target_channel_set

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

        # Идемпотентность теперь работает per-канал (см. already_sent_set ниже,
        # после получения targets_by_tg) — fanout может слать одному tg_id
        # через несколько ботов, поэтому защита от дубля смотрит пару (tg_id, channel_id).

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

        # {game_link} — ссылка на вкладку «Игра» события (личный кабинет получателя).
        # Используется в `2h_before_reg` / `day_before_09_12_reg` — это уже зарегистрированные
        # участники, их реферер уже зафиксирован при регистрации, перезатирать не надо.
        # Формат: t.me/{бот_клиента_или_pluson}?startapp=ref_pg{slug}_tabgame  (БЕЗ pid).
        # Mini App опознаёт получателя по tg_id из initData.
        needs_game_link = "{game_link}" in (text or "") or "{game_link}" in (button_url or "")
        game_link_url = ""
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
            game_link_url = f"{glink_bot_url}?startapp=ref_pg{event_slug_for_glink}_tabgame"

        # Fanout: для каждого получателя — список ВСЕХ подписанных каналов клиента
        # (is_unsubscribed=FALSE). По каждому каналу отправляем отдельное сообщение.
        # Если у получателя нет ни одной записи в platform_user_channels (легаси-контакт) —
        # шлём одно сообщение через default_bot_token (главный канал клиента).
        # Главный токен клиента (для определения channel_id легаси-fallback).
        default_channel_id = await conn.fetchval(
            """SELECT ch.id FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1 AND ch.platform_slug = 'telegram'
                  AND ch.bot_token = $2
                ORDER BY cc.is_active DESC, ch.id LIMIT 1""",
            schedule["client_id"], default_bot_token,
        )

        targets_by_tg = await get_telegram_send_targets(
            schedule["client_id"], list(final_ids), conn
        )

        # Идемпотентность с учётом канала: исключаем уже отправленные пары (tg_id, channel_id).
        already_sent_pairs = await conn.fetch(
            """
            SELECT pu.platform_user_id AS tg_id, bl.channel_id
              FROM broadcast_log bl
              JOIN platform_users pu ON pu.id = bl.platform_user_id
             WHERE bl.schedule_id = $1 AND bl.status = 'sent'
            """,
            schedule_id
        )
        already_sent_set = {(r["tg_id"], r["channel_id"]) for r in already_sent_pairs}

        # Разворачиваем final_ids в плоский список заданий (tg_id, channel_id, bot_token).
        # Если у рассылки задан target_channel_set — оставляем только указанные каналы.
        send_jobs: list[tuple[str, int | None, str]] = []
        for tg_id in final_ids:
            ch_list = targets_by_tg.get(tg_id) or []
            if ch_list:
                for t in ch_list:
                    if not _channel_allowed(t["channel_id"]):
                        continue
                    if (tg_id, t["channel_id"]) in already_sent_set:
                        continue
                    send_jobs.append((tg_id, t["channel_id"], t["bot_token"]))
            else:
                # Легаси-контакт без записи в platform_user_channels — fallback на главный канал.
                if not _channel_allowed(default_channel_id):
                    continue
                if (tg_id, default_channel_id) in already_sent_set:
                    continue
                send_jobs.append((tg_id, default_channel_id, default_bot_token))

        if already_sent_set:
            logger.info(f"Рассылка {schedule_id}: пропускаем {len(already_sent_set)} уже успешно отправленных пар (tg_id, channel)")

        # Отправляем параллельно (скорость = clients.broadcast_concurrency)
        sent = 0
        sem = asyncio.Semaphore(concurrency)

        async def send_one(tg_id: str, channel_id: int | None, token: str, http_client: httpx.AsyncClient):
            async with sem:
                msg_text = text
                msg_btn_url = button_url
                if needs_first_name:
                    msg_text = msg_text.replace("{first_name}", name_by_tg.get(tg_id, "друг"))
                if needs_game_link:
                    msg_text = msg_text.replace("{game_link}", game_link_url)
                    if msg_btn_url:
                        msg_btn_url = msg_btn_url.replace("{game_link}", game_link_url)
                ok, err = await send_telegram_message(
                    http_client, token, tg_id, msg_text, photo_url, button_text, msg_btn_url,
                    buttons=buttons
                )
                return tg_id, channel_id, (ok, err)

        async with httpx.AsyncClient(timeout=15, limits=httpx.Limits(max_connections=max(concurrency + 20, 50))) as http_client:
            results = await asyncio.gather(*[send_one(t, c, tok, http_client) for (t, c, tok) in send_jobs])

        # Пишем лог одной пачкой после отправки
        BLOCKED_ERRORS = ("bot was blocked by the user", "user is deactivated", "chat not found", "have no rights to send a message")
        for tg_id, channel_id, (success, tg_error) in results:
            is_blocked = not success and tg_error and any(e in tg_error.lower() for e in BLOCKED_ERRORS)
            await conn.execute(
                """
                INSERT INTO broadcast_log (schedule_id, platform_user_id, channel_id, status, error, sent_at)
                SELECT $1, pu.id, $6, $2, $3, NOW()
                FROM platform_users pu
                WHERE pu.platform_slug = 'telegram' AND pu.platform_user_id = $4 AND pu.client_id = $5
                """,
                schedule_id,
                "sent" if success else "failed",
                tg_error or None,
                tg_id,
                schedule["client_id"],
                channel_id,
            )
            if is_blocked:
                # Помечаем отписавшимся в КОНКРЕТНОМ канале через который слали.
                # Если канала не было (легаси) — отметим в главном.
                await mark_unsubscribed_by_tg_id(
                    schedule["client_id"], tg_id, conn, channel_id=channel_id
                )
            if success:
                sent += 1

        # Отправка копии в дополнительные чаты (events.telegram_chat_ids — общая колонка
        # для мероприятий и конференций, миграция 076).
        # Эти чаты — служебные группы клиента, шлём через главного бота.
        if not schedule["is_test"]:
            chat_ids_row = await conn.fetchrow(
                "SELECT telegram_chat_ids FROM events WHERE id = $1",
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

        # === VK подписчики (доп. слой, после TG) ===
        # Шлём VK-подписчикам клиента ту же рассылку через VK API messages.send.
        # Контакты учитываются отдельно: один человек может быть в TG-базе И VK-базе одновременно —
        # получит сообщение в обоих местах (это норма, см. CLAUDE.md «один контакт в нескольких контекстах»).
        try:
            vk_sent = await _send_broadcast_vk_part(
                conn, schedule, event_id, text, photo_url, button_text, button_url,
                buttons=buttons, target_channel_set=target_channel_set,
            )
            sent += vk_sent
            logger.info(f"VK-часть рассылки {schedule_id}: отправлено {vk_sent}")
        except Exception as ex:
            logger.warning(f"VK-часть рассылки {schedule_id} упала: {ex}")

        # === MAX подписчики (доп. слой, после VK) ===
        # Та же логика: MAX-подписчики клиента получают рассылку через MAX Bot API.
        # Токен — клиентского MAX-бота если у клиента есть свой (is_system=FALSE),
        # иначе системный MAX_SYSTEM_BOT_TOKEN из .env.
        try:
            max_sent = await _send_broadcast_max_part(
                conn, schedule, event_id, text, photo_url, button_text, button_url,
                buttons=buttons, target_channel_set=target_channel_set,
            )
            sent += max_sent
            logger.info(f"MAX-часть рассылки {schedule_id}: отправлено {max_sent}")
        except Exception as ex:
            logger.warning(f"MAX-часть рассылки {schedule_id} упала: {ex}")

        # === Email подписчики (доп. слой, после MAX) ===
        # Email-получатели клиента получают рассылку через локальный Postfix
        # с главного email-канала клиента. Один человек = один email = одно письмо.
        try:
            email_sent = await _send_broadcast_email_part(
                conn, schedule, event_id, text, photo_url, button_text, button_url,
                buttons=buttons, target_channel_set=target_channel_set,
            )
            sent += email_sent
            logger.info(f"Email-часть рассылки {schedule_id}: отправлено {email_sent}")
        except Exception as ex:
            logger.warning(f"Email-часть рассылки {schedule_id} упала: {ex}")

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


async def _send_broadcast_vk_part(
    conn, schedule, event_id: int | None,
    text: str, photo_url: str | None, button_text: str | None, button_url: str | None,
    buttons: list | None = None,
    target_channel_set: set[int] | None = None,
) -> int:
    """Отправляет рассылку VK-подписчикам клиента через VK API messages.send.

    Использует системный VK community token (VK_SYSTEM_GROUP_TOKEN). У не-VIP клиентов
    нет своего VK-сообщества — все сообщения идут от единого сообщества iViSiON: ПЛЮСОН
    (см. memory/vk_prod.md). VIP-VK будем поддерживать позже когда добавим client_channels
    с platform='vk' и channel.bot_token.

    Возвращает количество успешно отправленных сообщений.
    """
    from app.services.vk_api import (
        send_message as vk_send,
        tg_inline_to_vk_keyboard,
        upload_photo_to_messages as vk_upload_photo,
    )
    from app.config import settings as _vk_settings

    client_id = schedule["client_id"]
    aud_include = schedule.get("audience_include") or "all_event"

    # Какое VK-сообщество шлёт рассылку. Приоритет — собственное сообщество
    # клиента (channels.is_system=FALSE с непустым токеном), fallback на
    # системное iViSiON: ПЛЮСОН. Аналогично логике MAX-части.
    client_vk = await conn.fetchrow(
        """SELECT ch.id AS channel_id, ch.bot_token
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1 AND cc.is_active = TRUE
              AND ch.platform_slug = 'vk' AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
            LIMIT 1""",
        client_id,
    )
    if client_vk:
        vk_token = client_vk["bot_token"]
        vk_channel_id = client_vk["channel_id"]
    else:
        vk_token = _vk_settings.vk_system_group_token
        # ID системного VK-канала — для записи в broadcast_log
        vk_channel_id = await conn.fetchval(
            """SELECT id FROM channels
                WHERE platform_slug = 'vk' AND is_system = TRUE
                ORDER BY is_test ASC, id LIMIT 1"""
        )
    if not vk_token:
        return 0  # ни своего сообщества, ни системного токена

    # Фильтр «Каналы для отправки» (миграция 100): если задан явный список —
    # пропускаем всю VK-часть, когда её канал не выбран. NULL = все каналы.
    if target_channel_set is not None and vk_channel_id not in target_channel_set:
        return 0

    # Какие VK-подписчики клиента в зависимости от аудитории
    if aud_include == "all_client":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id
                 FROM platform_users pu
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE pu.client_id = $1
                  AND pu.platform_slug = 'vk'
                  AND ch.platform_slug = 'vk'
                  AND puc.is_unsubscribed = FALSE""",
            client_id,
        )
    elif event_id and aud_include == "registered_event":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'vk'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1 AND ep.is_registered = TRUE
                  AND ch.platform_slug = 'vk' AND puc.is_unsubscribed = FALSE""",
            event_id,
        )
    elif event_id:
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'vk'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1
                  AND ch.platform_slug = 'vk' AND puc.is_unsubscribed = FALSE""",
            event_id,
        )
    else:
        return 0

    # Тестовый режим: сужаем VK-аудиторию до clients.test_vk_ids ∩ обычная аудитория.
    # Если test_vk_ids пуст — VK-часть пропускается (никому ничего не отправляем).
    if schedule.get("is_test"):
        test_vk = await conn.fetchval(
            "SELECT test_vk_ids FROM clients WHERE id=$1", client_id
        )
        test_vk_set = {str(t) for t in (test_vk or [])}
        if not test_vk_set:
            return 0
        rows = [r for r in rows if str(r["platform_user_id"]) in test_vk_set]
        if not rows:
            return 0

    keyboard = None
    if buttons:
        # Конвертация массива кнопок [{label, url}, ...] в VK keyboard
        keyboard_rows = [[{"text": b.get("label", "Открыть"), "url": b.get("url", "")}] for b in buttons]
        keyboard = tg_inline_to_vk_keyboard(keyboard_rows)
    elif button_text and button_url:
        keyboard = tg_inline_to_vk_keyboard([[{"text": button_text, "url": button_url}]])

    # Загружаем фото в VK один раз для всей рассылки — получаем attachment-строку
    # `photo{owner_id}_{id}`, которую можно слать многим получателям. Без этого
    # фото уходило как обычный URL в тексте (без превью, как голая ссылка).
    # Загружаем под тем же токеном, которым шлём — иначе owner_id фото будет
    # чужим и VK отклонит сообщение.
    photo_attachment: str | None = None
    if photo_url:
        try:
            photo_attachment = await vk_upload_photo(photo_url, token=vk_token)
        except Exception as e:
            logger.warning(f"VK photo upload failed for {photo_url}: {e}")
        if not photo_attachment:
            logger.warning(f"VK photo upload returned None — отправим как ссылку: {photo_url}")

    sent = 0
    for r in rows:
        try:
            vk_id_int = int(r["platform_user_id"])
        except (TypeError, ValueError):
            continue
        message_text = text or ""
        # Fallback: если загрузить фото не получилось — вшиваем URL в текст,
        # VK развернёт превью по Open Graph (хуже превью, но лучше чем ничего).
        if photo_url and not photo_attachment:
            message_text = f"{photo_url}\n\n{message_text}".strip()
        ok = False
        err: str | None = None
        vk_message_id: int | None = None
        try:
            res = await vk_send(
                vk_id_int, message_text,
                token=vk_token,
                keyboard=keyboard, attachment=photo_attachment,
            )
            ok = bool(res)
            if ok and isinstance(res, int):
                vk_message_id = res
            if not ok:
                err = "VK send returned None"
        except Exception as e:
            err = str(e)
            logger.warning(f"VK send failed for vk_id={vk_id_int}: {e}")
        # Лог отправки — модалка «Получатели рассылки» читает отсюда.
        # external_message_id = vk message_id из messages.send — нужен чтобы
        # потом при event'е message_read сопоставить запись и поставить read_at.
        try:
            await conn.execute(
                """INSERT INTO broadcast_log
                       (schedule_id, platform_user_id, channel_id, status, error,
                        external_message_id, sent_at)
                   VALUES ($1, $2, $3, $4, $5, $6, NOW())""",
                schedule["id"], r["pu_id"], vk_channel_id,
                "sent" if ok else "failed", err, vk_message_id,
            )
        except Exception as e:
            logger.warning(f"VK broadcast_log insert failed for pu_id={r['pu_id']}: {e}")
        if ok:
            sent += 1
    return sent


async def _send_broadcast_max_part(
    conn, schedule, event_id: int | None,
    text: str, photo_url: str | None, button_text: str | None, button_url: str | None,
    buttons: list | None = None,
    target_channel_set: set[int] | None = None,
) -> int:
    """Отправляет рассылку MAX-подписчикам клиента через MAX Bot API.

    Токен резолвится так:
    - У клиента есть свой MAX-бот (channels.is_system=FALSE) → его bot_token
    - Иначе → системный settings.max_system_bot_token из .env

    chat_id для приватного диалога с пользователем = его MAX user_id.

    Возвращает количество успешно отправленных сообщений.
    """
    from app.services.max_api import send_message as max_send, tg_inline_to_max_keyboard
    from app.config import settings as _settings

    client_id = schedule["client_id"]
    aud_include = schedule.get("audience_include") or "all_event"

    # Какой MAX-бот используется для рассылок этого клиента
    client_max = await conn.fetchrow(
        """SELECT ch.id AS channel_id, ch.bot_token
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE
              AND ch.platform_slug = 'max'
              AND ch.is_system = FALSE
              AND ch.bot_token IS NOT NULL
              AND ch.bot_token <> ''
            LIMIT 1""",
        client_id,
    )
    if client_max:
        max_token = client_max["bot_token"]
        max_channel_id = client_max["channel_id"]
    else:
        max_token = _settings.max_system_bot_token
        max_channel_id = await conn.fetchval(
            """SELECT id FROM channels
                WHERE platform_slug = 'max' AND is_system = TRUE
                ORDER BY is_test ASC, id LIMIT 1"""
        )
    if not max_token:
        return 0  # У клиента нет MAX-бота и системный токен не настроен

    # Фильтр «Каналы для отправки» (миграция 100).
    if target_channel_set is not None and max_channel_id not in target_channel_set:
        return 0

    # Аудитория — те же 3 варианта что у VK
    if aud_include == "all_client":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id
                 FROM platform_users pu
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE pu.client_id = $1
                  AND pu.platform_slug = 'max'
                  AND ch.platform_slug = 'max'
                  AND puc.is_unsubscribed = FALSE""",
            client_id,
        )
    elif event_id and aud_include == "registered_event":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'max'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1 AND ep.is_registered = TRUE
                  AND ch.platform_slug = 'max' AND puc.is_unsubscribed = FALSE""",
            event_id,
        )
    elif event_id:
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'max'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1
                  AND ch.platform_slug = 'max' AND puc.is_unsubscribed = FALSE""",
            event_id,
        )
    else:
        return 0

    # Тестовый режим: сужаем MAX-аудиторию до clients.test_max_ids ∩ обычная аудитория.
    # Если test_max_ids пуст — MAX-часть пропускается.
    if schedule.get("is_test"):
        test_max = await conn.fetchval(
            "SELECT test_max_ids FROM clients WHERE id=$1", client_id
        )
        test_max_set = {str(t) for t in (test_max or [])}
        if not test_max_set:
            return 0
        rows = [r for r in rows if str(r["platform_user_id"]) in test_max_set]
        if not rows:
            return 0

    max_buttons = None
    if buttons:
        rows_btn = [[{"text": b.get("label", "Открыть"), "url": b.get("url", "")}] for b in buttons]
        max_buttons = tg_inline_to_max_keyboard(rows_btn)
    elif button_text and button_url:
        max_buttons = tg_inline_to_max_keyboard([[{"text": button_text, "url": button_url}]])

    sent = 0
    for r in rows:
        try:
            max_id_int = int(r["platform_user_id"])
        except (TypeError, ValueError):
            continue
        message_text = text or ""
        # photo_url пока шлём как ссылку в начале текста; нативную загрузку через
        # /uploads добавим в следующей итерации (как у VK)
        if photo_url:
            message_text = f"{photo_url}\n\n{message_text}".strip()
        ok = False
        err: str | None = None
        try:
            res = await max_send(max_id_int, message_text, token=max_token, buttons=max_buttons)
            ok = bool(res)
            if not ok:
                err = "MAX send returned None"
        except Exception as e:
            err = str(e)
            logger.warning(f"MAX send failed for max_id={max_id_int}: {e}")
        # Лог отправки — чтобы MAX-получатели тоже попадали в модалку «Получатели рассылки».
        try:
            await conn.execute(
                """INSERT INTO broadcast_log
                       (schedule_id, platform_user_id, channel_id, status, error, sent_at)
                   VALUES ($1, $2, $3, $4, $5, NOW())""",
                schedule["id"], r["pu_id"], max_channel_id,
                "sent" if ok else "failed", err,
            )
        except Exception as e:
            logger.warning(f"MAX broadcast_log insert failed for pu_id={r['pu_id']}: {e}")
        if ok:
            sent += 1
    return sent


async def _send_broadcast_email_part(
    conn, schedule, event_id: int | None,
    text: str, photo_url: str | None, button_text: str | None, button_url: str | None,
    buttons: list | None = None,
    target_channel_set: set[int] | None = None,
) -> int:
    """Отправляет рассылку email-подписчикам клиента через локальный Postfix.

    Адрес отправителя берётся из главного email-канала клиента
    (channels.email_subdomain / email_from_local / email_from_name). Если канал
    системный (email_subdomain=NULL) — шлём от noreply@pluson.ru с именем,
    взятым из clients.brand_name (или clients.name как fallback).

    photo_url пока не используется (plain-text MVP), кнопка вставляется
    ссылкой в конец текста — HTML-вёрстка появится в следующей итерации
    (планируется визуальный редактор + рендер HTML-блока для кнопки).

    Возвращает количество успешно отправленных писем.
    """
    from app.services.email_sender import EmailSender, EmailSendError
    from app.services.unsubscribe_token import make_email_unsubscribe_token

    client_id = schedule["client_id"]
    aud_include = schedule.get("audience_include") or "all_event"

    # Главный email-канал клиента + параметры отправителя
    channel = await conn.fetchrow(
        """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                  ch.email_subdomain, ch.email_from_local, ch.email_from_name,
                  cl.brand_name, cl.name AS client_name
             FROM client_channels cc
             JOIN channels ch ON ch.id = cc.channel_id
             JOIN clients cl ON cl.id = cc.client_id
            WHERE cc.client_id = $1
              AND cc.is_active = TRUE
              AND ch.platform_slug = 'email'
            ORDER BY cc.added_at LIMIT 1""",
        client_id,
    )
    if not channel:
        # У клиента нет email-канала вообще (рассинхрон с миграцией 097).
        return 0

    # Фильтр «Каналы для отправки» (миграция 100).
    if target_channel_set is not None and channel["channel_id"] not in target_channel_set:
        return 0

    channel_dict = dict(channel)
    client_brand_name = channel_dict.get("brand_name") or channel_dict.get("client_name") or "ПЛЮСОН"

    # Получатели — email-identity с активной подпиской на ЭТОТ канал
    # и не помеченные как битые (email_is_dead).
    if aud_include == "all_client":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.contact_id, pu.platform_user_id AS email,
                      COALESCE(NULLIF(pu.first_name, ''), c.name, 'друг') AS first_name
                 FROM platform_users pu
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE pu.client_id = $1
                  AND pu.platform_slug = 'email'
                  AND pu.email_is_dead = FALSE
                  AND puc.client_channel_id = $2
                  AND puc.is_unsubscribed = FALSE""",
            client_id, channel_dict["client_channel_id"],
        )
    elif event_id and aud_include == "registered_event":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.contact_id, pu.platform_user_id AS email,
                      COALESCE(NULLIF(pu.first_name, ''), c.name, 'друг') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'email'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE ep.event_id = $1 AND ep.is_registered = TRUE
                  AND pu.email_is_dead = FALSE
                  AND puc.client_channel_id = $2
                  AND puc.is_unsubscribed = FALSE""",
            event_id, channel_dict["client_channel_id"],
        )
    elif event_id:
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.contact_id, pu.platform_user_id AS email,
                      COALESCE(NULLIF(pu.first_name, ''), c.name, 'друг') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'email'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE ep.event_id = $1
                  AND pu.email_is_dead = FALSE
                  AND puc.client_channel_id = $2
                  AND puc.is_unsubscribed = FALSE""",
            event_id, channel_dict["client_channel_id"],
        )
    else:
        return 0

    # Тестовый режим: для email пока нет отдельного test-списка email-адресов.
    # Если is_test=TRUE — шлём только на email-адреса контактов, у которых
    # есть TG-id из clients.test_telegram_ids (то есть тестовые «свои люди»).
    if schedule.get("is_test"):
        test_tg = await conn.fetchval(
            "SELECT test_telegram_ids FROM clients WHERE id=$1", client_id
        )
        test_tg_set = {str(t) for t in (test_tg or [])}
        if not test_tg_set:
            return 0
        # Ищем contact_id'ы которые имеют TG-identity из тестового списка
        test_contact_ids = await conn.fetch(
            """SELECT DISTINCT contact_id FROM platform_users
                WHERE client_id = $1 AND platform_slug = 'telegram'
                  AND platform_user_id = ANY($2::text[])""",
            client_id, list(test_tg_set),
        )
        test_set = {r["contact_id"] for r in test_contact_ids}
        rows = [r for r in rows if r["contact_id"] in test_set]
        if not rows:
            return 0

    # Готовим текст письма. Subject из шаблона рассылок появится в следующей
    # итерации (поле broadcast_templates.subject — отдельная миграция). Пока
    # тема собирается из первой строки текста, если она короткая.
    body_text = text or ""
    first_line = body_text.split("\n", 1)[0].strip() if body_text else ""
    subject = first_line if (0 < len(first_line) <= 120) else "Новое сообщение от ПЛЮСОН"

    # Кнопка → текстовая ссылка в конце письма (для email-каналов кнопка
    # рендерится как стилизованная ссылка; полноценный HTML-блок-кнопка
    # появится с HTML-вёрсткой писем — следующий подэтап).
    if button_text and button_url:
        body_text = body_text.rstrip() + f"\n\n{button_text}: {button_url}"
    elif buttons:
        body_text = body_text.rstrip() + "\n\n" + "\n".join(
            f"{b.get('label','Открыть')}: {b.get('url','')}" for b in buttons
        )

    sender = EmailSender()
    sent = 0
    for r in rows:
        email_addr = (r["email"] or "").strip()
        if not email_addr or "@" not in email_addr:
            continue

        # Персональный токен отписки на пару (контакт × канал клиента)
        unsub_token = make_email_unsubscribe_token(
            client_id=client_id,
            contact_id=r["contact_id"],
            client_channel_id=channel_dict["client_channel_id"],
        )

        # Персонализация: {first_name}
        msg_text = body_text
        if "{first_name}" in msg_text:
            msg_text = msg_text.replace("{first_name}", r["first_name"] or "друг")

        ok = False
        err: str | None = None
        msg_id: str | None = None
        try:
            msg_id = sender.send(
                channel=channel_dict,
                client_brand_name=client_brand_name,
                to_email=email_addr,
                subject=subject,
                body_text=msg_text,
                unsubscribe_token=unsub_token,
            )
            ok = True
        except EmailSendError as e:
            err = str(e)

        # Лог отправки — модалка «Получатели рассылки» читает отсюда
        try:
            await conn.execute(
                """INSERT INTO broadcast_log
                       (schedule_id, platform_user_id, channel_id, status, error,
                        external_message_id, sent_at)
                   VALUES ($1, $2, $3, $4, $5, $6, NOW())""",
                schedule["id"], r["pu_id"], channel_dict["channel_id"],
                "sent" if ok else "failed", err, msg_id,
            )
        except Exception as e:
            logger.warning(f"Email broadcast_log insert failed for pu_id={r['pu_id']}: {e}")

        if ok:
            sent += 1
    return sent


async def _build_audience(conn, schedule) -> set:
    aud_include = schedule["audience_include"] or "all_event"
    aud_exclude = schedule["audience_exclude"] or "none"
    event_id = schedule["event_id"]
    client_id = schedule["client_id"]

    # Подписан = есть хотя бы один не-отписанный telegram-канал клиента,
    # либо записей в platform_user_channels нет вовсе (легаси-контакты).
    # Если человек отписался от ВСЕХ каналов клиента — исключаем.
    # Архитектура G: ходим через client_channels (puc.client_channel_id → cc → ch).
    SUBSCRIBED_CLAUSE = """
        (
          EXISTS (
            SELECT 1 FROM platform_user_channels puc
            JOIN client_channels cc ON cc.id = puc.client_channel_id
            JOIN channels ch ON ch.id = cc.channel_id
            WHERE puc.platform_user_id = pu.id
              AND cc.client_id = pu.client_id
              AND ch.platform_slug = 'telegram'
              AND puc.is_unsubscribed = FALSE
          )
          OR NOT EXISTS (
            SELECT 1 FROM platform_user_channels puc
            JOIN client_channels cc ON cc.id = puc.client_channel_id
            JOIN channels ch ON ch.id = cc.channel_id
            WHERE puc.platform_user_id = pu.id
              AND cc.client_id = pu.client_id
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


# ─────────────────────────────────────────
# Cleanup временных фото произвольных рассылок
# ─────────────────────────────────────────
# Произвольная рассылка может прикреплять фото, загруженное прямо в этой сессии
# (kind='broadcast_photo' в client_files). Чтобы не засорять хранилище после
# отправки — удаляем такие фото из R2 + БД через 10 минут после завершения
# рассылки. Орфаны (загрузили и не использовали) — через час.
@celery.task(name="app.tasks.broadcast.cleanup_broadcast_photos")
def cleanup_broadcast_photos():
    run_async(_cleanup_broadcast_photos())


async def _cleanup_broadcast_photos():
    from app.services import r2_storage
    conn = await _get_conn()
    try:
        # 1. Фото, использованные в рассылках, которые завершились (done/cancelled/
        #    paused_subscription_expired) > 10 минут назад.
        used_rows = await conn.fetch(
            """
            SELECT DISTINCT cf.id, cf.r2_key, cf.size_bytes, cf.client_id
              FROM client_files cf
              JOIN broadcast_schedules bs ON bs.snapshot_photo = cf.url
             WHERE cf.kind = 'broadcast_photo'
               AND bs.status IN ('done', 'cancelled', 'paused_subscription_expired')
               AND bs.finished_at IS NOT NULL
               AND bs.finished_at < NOW() - INTERVAL '10 minutes'
            """
        )

        # 2. Орфаны: загружены > 1 часа назад и ни в одной рассылке не используются.
        orphan_rows = await conn.fetch(
            """
            SELECT cf.id, cf.r2_key, cf.size_bytes, cf.client_id
              FROM client_files cf
             WHERE cf.kind = 'broadcast_photo'
               AND cf.created_at < NOW() - INTERVAL '1 hour'
               AND NOT EXISTS (
                 SELECT 1 FROM broadcast_schedules bs WHERE bs.snapshot_photo = cf.url
               )
            """
        )

        # Дедуп по id
        all_rows = {r["id"]: r for r in (list(used_rows) + list(orphan_rows))}
        if not all_rows:
            return

        for row in all_rows.values():
            try:
                await r2_storage.delete_object(row["r2_key"])
            except Exception as e:
                logger.warning(f"cleanup_broadcast_photos: не смог удалить из R2 {row['r2_key']}: {e}")
            async with conn.transaction():
                await conn.execute("DELETE FROM client_files WHERE id = $1", row["id"])
                await conn.execute(
                    "UPDATE clients SET storage_used_bytes = GREATEST(0, storage_used_bytes - $1) WHERE id = $2",
                    int(row["size_bytes"]), row["client_id"],
                )
        logger.info(f"cleanup_broadcast_photos: удалено {len(all_rows)} файлов")
    finally:
        await conn.close()
