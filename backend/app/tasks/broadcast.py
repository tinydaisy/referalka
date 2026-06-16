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
            SELECT bs.*, COALESCE((SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1), bs.client_id) AS client_id,
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
            "SELECT subject, text, photo_url, video_url, media_type, video_file_id, "
            "button_text, button_url, target_channel_ids "
            "FROM broadcast_templates WHERE id=$1",
            schedule["template_id"]
        ) if schedule["template_id"] else None
        tmpl_subject_val  = tmpl["subject"]      if tmpl else None
        tmpl_text_val  = tmpl["text"]         if tmpl else ""
        tmpl_photo_val = tmpl["photo_url"]    if tmpl else None
        tmpl_video_val = tmpl["video_url"]    if tmpl else None
        tmpl_media_type_val = tmpl["media_type"] if tmpl else None
        tmpl_video_file_id_val = tmpl["video_file_id"] if tmpl else None
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
            # Архитектура G (миграция 066): у channels НЕТ client_id — связь через
            # junction client_channels. Берём любой TG-канал клиента с токеном.
            default_bot_token = await conn.fetchval(
                """SELECT ch.bot_token FROM channels ch
                     JOIN client_channels cc ON cc.channel_id = ch.id
                    WHERE cc.client_id = $1 AND ch.platform_slug = 'telegram'
                      AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''
                    ORDER BY cc.is_active DESC, ch.id ASC LIMIT 1""",
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
                "video": schedule.get("snapshot_video"),
                "media_type": schedule.get("snapshot_media_type"),
                "buttons": snap_buttons or [],
            }
            # snapshot_subject имеет приоритет над template.subject для custom-рассылок
            snap_subject = schedule.get("snapshot_subject")
            if snap_subject:
                tmpl_subject_val = snap_subject

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
            video_url=tmpl_video_val,
            media_type=tmpl_media_type_val,
        )

        text = content["text"]
        photo_url = content["photo"]
        video_url = content.get("video")
        media_type = content.get("media_type")
        button_text = content.get("button_text")
        button_url = content.get("button_url")
        buttons = content.get("buttons") or None

        # Кеш Telegram file_id для видео: чтобы не качать файл с R2 на каждого
        # получателя — первый успешный sendVideo вернёт file_id, дальше шлём по нему.
        # Для шаблонных рассылок начальный file_id берём из шаблона (если уже грелся
        # на прошлых отправках), для произвольных — из снапшота расписания.
        video_file_id = None
        if media_type == "video":
            video_file_id = (
                schedule.get("snapshot_video_file_id")
                or (tmpl_video_file_id_val if tpl_type != "custom" else None)
            )
        # Куда сохранить свежий file_id после первой отправки (один раз).
        _vid_fid_holder = {"fid": video_file_id, "saved": False}

        def _capture_video_file_id(fid: str):
            if not fid or _vid_fid_holder["saved"]:
                return
            _vid_fid_holder["fid"] = fid
            _vid_fid_holder["saved"] = True  # пометим, реальный UPDATE сделаем после рассылки

        # Заголовок шаблона (subject) — для TG/VK/MAX добавляем первой жирной строкой,
        # для email — становится темой письма (передаётся в _send_broadcast_email_part).
        subject_val = (tmpl_subject_val or "").strip() if tmpl_subject_val else ""
        text_for_email = text or ""        # чистый body без subject-префикса
        if subject_val:
            # Telegram parse_mode=HTML понимает <b>; VK strip-ит и оставляет текст;
            # MAX тоже принимает <b>. Просто префикс жирной строкой + пустая строка.
            text = f"<b>{subject_val}</b>\n\n{text or ''}"

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
            # Бот клиента (VIP) или общий @pluson_bot/pluson.
            # Архитектура G (миграция 066): у channels НЕТ client_id — связь
            # канал↔клиент только через junction client_channels. Берём активный
            # НЕ системный TG-бот клиента (VIP). Если своего бота нет — fallback
            # на общий @pluson_bot/pluson ниже.
            bot_handle = await conn.fetchval(
                """SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                     FROM channels ch
                     JOIN client_channels cc ON cc.channel_id = ch.id
                    WHERE cc.client_id = $1 AND ch.platform_slug = 'telegram'
                      AND cc.is_active = true AND ch.is_system = false
                      AND ch.bot_token IS NOT NULL
                    LIMIT 1""",
                schedule["client_id"]
            )
            glink_bot_url = (f"https://t.me/{bot_handle}" if bot_handle
                             else "https://t.me/pluson_bot/pluson")
            game_link_url = f"{glink_bot_url}?startapp=ref_pg{event_slug_for_glink}_tabgame"

        # Персональный сквозной маркер контакта `_ct{contact_id}` в {game_link}.
        # При клике на чужой платформе человек привяжется к своему контакту,
        # а не создаст дубль. Мапа tg_id → contact_id для получателей-телеграмеров;
        # если contact_id неизвестен — используем общий game_link_url (как раньше).
        contact_by_tg: dict[str, int] = {}
        if needs_game_link and final_ids:
            ct_rows = await conn.fetch(
                """SELECT platform_user_id, contact_id
                     FROM platform_users
                    WHERE client_id=$1 AND platform_slug='telegram'
                      AND platform_user_id = ANY($2::text[])
                      AND contact_id IS NOT NULL""",
                schedule["client_id"], list(final_ids),
            )
            contact_by_tg = {r["platform_user_id"]: r["contact_id"] for r in ct_rows}

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
                    # Персональная ссылка с `_ct{contact_id}` если контакт известен,
                    # иначе общая game_link_url (обратная совместимость).
                    ct = contact_by_tg.get(tg_id)
                    glink = f"{game_link_url}_ct{ct}" if ct else game_link_url
                    msg_text = msg_text.replace("{game_link}", glink)
                    if msg_btn_url:
                        msg_btn_url = msg_btn_url.replace("{game_link}", glink)
                ok, err = await send_telegram_message(
                    http_client, token, tg_id, msg_text, photo_url, button_text, msg_btn_url,
                    buttons=buttons,
                    video_url=video_url if media_type == "video" else None,
                    video_file_id=_vid_fid_holder["fid"] if media_type == "video" else None,
                    on_video_file_id=_capture_video_file_id if media_type == "video" else None,
                )
                return tg_id, channel_id, (ok, err)

        async with httpx.AsyncClient(timeout=15, limits=httpx.Limits(max_connections=max(concurrency + 20, 50))) as http_client:
            # Прогрев file_id: для видео без готового file_id шлём ПЕРВОМУ получателю
            # последовательно — Telegram скачает файл с R2 один раз и вернёт file_id,
            # дальше остальным шлём по нему мгновенно (без повторной заливки).
            results = []
            jobs = list(send_jobs)
            if media_type == "video" and not _vid_fid_holder["fid"] and jobs:
                first = jobs.pop(0)
                results.append(await send_one(first[0], first[1], first[2], http_client))
            results.extend(await asyncio.gather(*[send_one(t, c, tok, http_client) for (t, c, tok) in jobs]))

        # Сохраняем прогретый file_id, чтобы следующие рассылки этого видео шли мгновенно.
        fresh_fid = _vid_fid_holder["fid"]
        if media_type == "video" and fresh_fid:
            try:
                await conn.execute(
                    "UPDATE broadcast_schedules SET snapshot_video_file_id=$1 WHERE id=$2",
                    fresh_fid, schedule_id,
                )
                if schedule.get("template_id") and tpl_type != "custom":
                    await conn.execute(
                        "UPDATE broadcast_templates SET video_file_id=$1 WHERE id=$2",
                        fresh_fid, schedule["template_id"],
                    )
            except Exception as e:
                logger.warning(f"Не смог сохранить video_file_id для рассылки {schedule_id}: {e}")

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
                video_url=video_url, media_type=media_type,
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
                video_url=video_url, media_type=media_type,
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
                conn, schedule, event_id, text_for_email, photo_url, button_text, button_url,
                buttons=buttons, target_channel_set=target_channel_set,
                subject_override=subject_val or None,
                video_url=video_url, media_type=media_type,
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


def _vk_error_human(code: int | None, msg: str) -> str:
    """Человекочитаемая причина недоставки VK для broadcast_log.error.

    Показывается клиенту в модалке «Получатели рассылки», поэтому по-русски
    и без технического шума.
    """
    mapping = {
        901: "Не разрешил сообществу писать в личку",
        902: "Запрещено настройками приватности",
        7: "Нет прав на отправку этому пользователю",
        15: "Доступ закрыт (аккаунт удалён или заблокирован)",
    }
    if code in mapping:
        return mapping[code]
    if code is not None:
        return f"VK ошибка {code}: {msg}" if msg else f"VK ошибка {code}"
    return msg or "VK не принял сообщение"


async def _send_broadcast_vk_part(
    conn, schedule, event_id: int | None,
    text: str, photo_url: str | None, button_text: str | None, button_url: str | None,
    buttons: list | None = None,
    target_channel_set: set[int] | None = None,
    video_url: str | None = None,
    media_type: str | None = None,
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
        VK_CANT_MESSAGE_CODES,
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
        # Конвертация массива кнопок [{text|label, url}, ...] в VK keyboard.
        # snapshot_buttons из broadcasts/general хранит поле text;
        # шаблоны конференций могут хранить label.
        keyboard_rows = [[{"text": (b.get("text") or b.get("label") or "Открыть"), "url": b.get("url", "")}] for b in buttons]
        keyboard = tg_inline_to_vk_keyboard(keyboard_rows)
    elif button_text and button_url:
        keyboard = tg_inline_to_vk_keyboard([[{"text": button_text, "url": button_url}]])

    # Загружаем фото в VK один раз для всей рассылки — получаем attachment-строку
    # `photo{owner_id}_{id}`, которую можно слать многим получателям. Без этого
    # фото уходило как обычный URL в тексте (без превью, как голая ссылка).
    # Загружаем под тем же токеном, которым шлём — иначе owner_id фото будет
    # чужим и VK отклонит сообщение.
    photo_attachment: str | None = None
    if media_type != "video" and photo_url:
        try:
            photo_attachment = await vk_upload_photo(photo_url, token=vk_token)
        except Exception as e:
            logger.warning(f"VK photo upload failed for {photo_url}: {e}")
        if not photo_attachment:
            # Жёсткое правило: НЕ ВСТАВЛЯЕМ голую R2-ссылку в текст сообщения —
            # это выглядит уродливо и сбивает читателя. Если VK upload-сервер
            # упал (504/502 — встречается под нагрузкой), просто отправляем
            # сообщение без фото. Клиент увидит текст и кнопку, фото пропустим.
            logger.warning(
                f"VK photo upload failed после всех retries — шлём БЕЗ фото, "
                f"R2-ссылку в текст вшивать НЕ будем: {photo_url}"
            )

    # Видео: грузим в VK ОДИН раз для всей рассылки — получаем video-attachment,
    # который шлём всем получателям. Нативная загрузка (video.save) требует
    # user-токена админа сообщества; без него — fallback на doc (файл .mp4);
    # если совсем не вышло — fallback на ссылку в тексте (vk_link_fallback=True).
    video_attachment: str | None = None
    vk_link_fallback = False
    if media_type == "video" and video_url:
        from app.services.vk_api import (
            upload_video_via_user_token as vk_upload_video_native,
            upload_video_to_messages as vk_upload_video_doc,
        )
        from app.services.funnel_service import _vk_admin_user_token_for_client
        try:
            vk_user_tok, vk_user_grp = await _vk_admin_user_token_for_client(client_id, conn)
            if vk_user_tok:
                video_attachment = await vk_upload_video_native(
                    video_url, user_token=vk_user_tok, group_id=vk_user_grp
                )
            if not video_attachment:
                video_attachment = await vk_upload_video_doc(video_url, token=vk_token)
        except Exception as e:
            logger.warning(f"VK video upload failed for {video_url}: {e}")
        if not video_attachment:
            vk_link_fallback = True
            logger.warning(f"VK video upload не удался — шлём ссылкой в тексте: {video_url}")

    sent = 0
    for r in rows:
        try:
            vk_id_int = int(r["platform_user_id"])
        except (TypeError, ValueError):
            continue
        message_text = text or ""
        attachment = video_attachment if media_type == "video" else photo_attachment
        if media_type == "video" and vk_link_fallback:
            message_text = f"{message_text}\n\n🎬 Видео: {video_url}" if message_text else video_url
        # Раньше тут был fallback «если фото не залилось → вшиваем URL в текст».
        # Убрано: пользователь увидит уродливую R2-ссылку, и это выглядит как
        # спам. Лучше отправить только текст — фото потеряется, но сообщение
        # будет читаемым.
        ok = False
        err: str | None = None
        vk_message_id: int | None = None
        vk_err_code: int | None = None
        try:
            res = await vk_send(
                vk_id_int, message_text,
                token=vk_token,
                keyboard=keyboard, attachment=attachment,
                return_error=True,
            )
            # return_error=True → res = (message_id|None, error_code|None, error_msg)
            mid, vk_err_code, vk_err_msg = res
            ok = mid is not None
            if ok:
                vk_message_id = mid
            else:
                # Понятная причина в лог вместо «VK send returned None»
                if vk_err_code is not None:
                    err = _vk_error_human(vk_err_code, vk_err_msg)
                else:
                    err = vk_err_msg or "VK не принял сообщение"
        except Exception as e:
            err = str(e)
            logger.warning(f"VK send failed for vk_id={vk_id_int}: {e}")
        # Самоочистка базы: если VK сказал «этому юзеру писать нельзя» (901/902/7/15) —
        # помечаем его подписку отписанной, чтобы он не попадал в следующие рассылки
        # и не давал ложную «грязь» в статистике. Аналог пометки заблокировавших в TG.
        if vk_err_code in VK_CANT_MESSAGE_CODES:
            try:
                await conn.execute(
                    """UPDATE platform_user_channels
                          SET is_unsubscribed = TRUE, unsubscribed_at = NOW()
                        WHERE platform_user_id = $1
                          AND client_channel_id IN (
                              SELECT id FROM client_channels WHERE channel_id = $2
                          )
                          AND is_unsubscribed = FALSE""",
                    r["pu_id"], vk_channel_id,
                )
            except Exception as e:
                logger.warning(f"VK mark_unsubscribed failed for pu_id={r['pu_id']}: {e}")
        # Лог отправки — модалка «Получатели рассылки» читает отсюда.
        # external_message_id = vk message_id из messages.send — нужен чтобы
        # потом при event'е message_read сопоставить запись и поставить read_at.
        try:
            # external_message_id колонка TEXT — конвертируем int message_id из VK в str
            await conn.execute(
                """INSERT INTO broadcast_log
                       (schedule_id, platform_user_id, channel_id, status, error,
                        external_message_id, sent_at)
                   VALUES ($1, $2, $3, $4, $5, $6, NOW())""",
                schedule["id"], r["pu_id"], vk_channel_id,
                "sent" if ok else "failed", err,
                str(vk_message_id) if vk_message_id is not None else None,
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
    video_url: str | None = None,
    media_type: str | None = None,
) -> int:
    """Отправляет рассылку MAX-подписчикам клиента через MAX Bot API.

    Токен резолвится так:
    - У клиента есть свой MAX-бот (channels.is_system=FALSE) → его bot_token
    - Иначе → системный settings.max_system_bot_token из .env

    chat_id для приватного диалога с пользователем = его MAX user_id.

    Возвращает количество успешно отправленных сообщений.
    """
    from app.services.max_api import send_message as max_send, tg_inline_to_max_keyboard
    from app.services.message_builder import html_to_telegram
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
        rows_btn = [[{"text": (b.get("text") or b.get("label") or "Открыть"), "url": b.get("url", "")}] for b in buttons]
        max_buttons = tg_inline_to_max_keyboard(rows_btn)
    elif button_text and button_url:
        max_buttons = tg_inline_to_max_keyboard([[{"text": button_text, "url": button_url}]])

    sent = 0
    for r in rows:
        try:
            max_id_int = int(r["platform_user_id"])
        except (TypeError, ValueError):
            continue
        # MAX понимает inline-HTML (<b>/<i>/<a>) только при format='html'. Без
        # него теги уходят сырым текстом ("<b>...</b>" видно дословно). Чистим
        # блочные теги (<p>/<br>/<ul>) через html_to_telegram — MAX их не парсит —
        # и передаём parse_mode='html' ниже. MAX устойчив к незакрытым тегам и
        # HTML-сущностям (проверено), всё сообщение не отвергает.
        message_text = html_to_telegram(text or "")
        # MAX пока без нативной загрузки картинки. Раньше вшивали R2-URL в начало
        # текста — убрали по тому же правилу что для VK: голая R2-ссылка
        # выглядит как спам. Лучше шлём без фото; нативную загрузку в MAX
        # добавим отдельно. TODO: max_api.upload_photo + attachment.
        # if photo_url: ...  # не добавляем URL в текст
        # Видео в MAX: нативной загрузки из URL нет — даём ссылку на видео в текст,
        # чтобы подписчик гарантированно мог его открыть.
        if media_type == "video" and video_url:
            message_text = f"{message_text}\n\n🎬 Видео: {video_url}" if message_text else video_url
        ok = False
        err: str | None = None
        try:
            # Рассылка адресуется по user_id подписчика (platform_users.platform_user_id),
            # а не по id беседы — иначе MAX отвечает chat.not.found и молча не доставляет.
            res = await max_send(max_id_int, message_text, token=max_token, buttons=max_buttons, recipient_kind="user", parse_mode="html")
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
    subject_override: str | None = None,
    video_url: str | None = None,
    media_type: str | None = None,
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
    from app.api.email_tracking import make_open_token, make_click_token
    import re as _re_tracking
    import urllib.parse as _urlparse

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
    # Имя для From-заголовка и subject — короткий вариант (бренд если есть, иначе имя).
    client_brand_name = channel_dict.get("brand_name") or channel_dict.get("client_name") or "ПЛЮСОН"
    # Полное имя для подвала отписки — «{ИмяФамилия} и {Бренд}»; если бренд
    # не задан — только имя; если нет имени — только бренд; иначе ПЛЮСОН.
    _owner = (channel_dict.get("client_name") or "").strip()
    _brand = (channel_dict.get("brand_name") or "").strip()
    if _owner and _brand:
        footer_brand_label = f"{_owner} и {_brand}"
    elif _owner:
        footer_brand_label = _owner
    elif _brand:
        footer_brand_label = _brand
    else:
        footer_brand_label = "ПЛЮСОН"

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

    # Тестовый режим: сужаем аудиторию.
    # Источник 1 — clients.test_email_ids (явный список адресов, миграция 102).
    # Источник 2 — clients.test_telegram_ids → резолв в email-адреса того же контакта.
    # Их объединение и применяем. Если оба пусты — email-часть пропускаем.
    if schedule.get("is_test"):
        test_row = await conn.fetchrow(
            "SELECT test_email_ids, test_telegram_ids FROM clients WHERE id=$1", client_id
        )
        test_emails_set = {str(e).strip().lower() for e in (test_row["test_email_ids"] or []) if str(e).strip()}
        test_tg_set = {str(t) for t in (test_row["test_telegram_ids"] or [])}
        allowed_contact_ids: set[int] = set()
        if test_tg_set:
            tg_contact_rows = await conn.fetch(
                """SELECT DISTINCT contact_id FROM platform_users
                    WHERE client_id = $1 AND platform_slug = 'telegram'
                      AND platform_user_id = ANY($2::text[])""",
                client_id, list(test_tg_set),
            )
            allowed_contact_ids = {r["contact_id"] for r in tg_contact_rows}
        # ВАЖНО: для email-тестов используем ТОЛЬКО clients.test_email_ids.
        # Раньше был OR через allowed_contact_ids (контакты с тестовыми TG-id) —
        # из-за этого письмо уходило людям, чей TG-аккаунт в тестовых, но email
        # вовсе НЕ в test_email_ids. Это нарушало смысл «тестовых email».
        if not test_emails_set:
            return 0
        rows = [
            r for r in rows
            if r["email"] and str(r["email"]).strip().lower() in test_emails_set
        ]
        if not rows:
            return 0

    # Готовим текст письма. Subject из шаблона рассылок появится в следующей
    # итерации (поле broadcast_templates.subject — отдельная миграция). Пока
    # тема собирается из первой строки текста, если она короткая.
    import re as _re
    raw_text = text or ""

    # Видео в email не проигрывается встроенно (почтовые клиенты режут <video>).
    # Поэтому показываем КАРТИНКУ-ОБЛОЖКУ (первый кадр) как кликабельную ссылку
    # на видео — см. блок html_video_cover ниже. В plain-часть (для клиентов без
    # HTML) добавляем текстовую ссылку отдельно (body_text), в HTML — нет.
    is_video_email = bool(media_type == "video" and video_url)

    def _strip_html(s: str) -> str:
        """HTML-теги → пусто. Минимальный замены HTML-entities."""
        s = _re.sub(r"<br\s*/?>", "\n", s, flags=_re.IGNORECASE)
        s = _re.sub(r"</p\s*>", "\n\n", s, flags=_re.IGNORECASE)
        s = _re.sub(r"</li\s*>", "\n", s, flags=_re.IGNORECASE)
        s = _re.sub(r"<[^>]+>", "", s)
        s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
        return s

    # Subject:
    # 1) Если задан subject_override (поле «Заголовок» из формы рассылки или
    #    welcome_email_subject события) — используем его.
    # 2) Иначе — «Новое сообщение от {бренд клиента}». НЕ берём первую строку
    #    текста, чтобы тема не превращалась в обрезанный кусок body.
    if subject_override and subject_override.strip():
        subject = _strip_html(subject_override).strip()[:200]
    else:
        brand_for_subject = (client_brand_name or "ПЛЮСОН").strip()
        subject = f"Новое сообщение от {brand_for_subject}"

    # Email шлём ВСЕГДА multipart (HTML + plain-fallback): в HTML — фото в
    # начале, кликабельные ссылки, красивая кнопка в фирменных цветах
    # (#FFCFA4 фон, #25455D текст). plain-часть — как fallback для клиентов,
    # которые HTML не рендерят (редко).
    def _linkify(t: str) -> str:
        """Plain URL → <a href>. Применяем только к строкам где нет HTML."""
        return _re.sub(
            r"(?<![\"'>=])(https?://[^\s<]+)",
            r'<a href="\1" style="color:#3D8CB6;text-decoration:underline;">\1</a>',
            t,
        )

    has_html = bool(_re.search(r"<[a-zA-Z][^>]*>", raw_text))
    if has_html:
        # В тексте уже есть теги — переводим переносы в <br>, plain URL за
        # пределами тегов превращаем в кликабельные.
        html_inner = _linkify(raw_text.replace("\n", "<br>\n"))
    else:
        # Plain → экранируем спецсимволы, переносы → <br>, URL → <a>.
        escaped = (raw_text
                   .replace("&", "&amp;")
                   .replace("<", "&lt;")
                   .replace(">", "&gt;")
                   .replace("\n", "<br>\n"))
        html_inner = _linkify(escaped)

    # Фото в начале HTML — встраиваем как inline-attachment (multipart/related)
    # с Content-ID. Это надёжнее remote URL:
    # 1) Письмо автономно — R2 может удалить файл, картинка всё равно
    #    останется в письме у получателя.
    # 2) Gmail в спам-папке не блокирует inline-картинки так, как remote.
    # 3) Outlook/Apple Mail без «Show images» сразу показывают inline.
    # Скачиваем картинку один раз перед циклом получателей.
    html_image = ""
    inline_image_data: bytes | None = None
    inline_image_subtype: str = "jpeg"
    inline_image_cid: str = "broadcast_image"
    if photo_url:
        try:
            async with httpx.AsyncClient(timeout=15.0) as fetcher:
                resp = await fetcher.get(photo_url)
                if resp.status_code == 200:
                    inline_image_data = resp.content
                    ct = (resp.headers.get("content-type") or "").lower()
                    if "png" in ct:
                        inline_image_subtype = "png"
                    elif "gif" in ct:
                        inline_image_subtype = "gif"
                    elif "webp" in ct:
                        inline_image_subtype = "webp"
                    else:
                        inline_image_subtype = "jpeg"
                    # Gmail mobile/iOS Mail рендерят inline-картинку > ~100KB
                    # как «прикрепление снизу» вместо внутрь тела. Сжимаем
                    # JPEG'ом до ~80-90KB чтобы всегда показывалось inline.
                    # PNG/GIF не трогаем — у них прозрачность.
                    if inline_image_subtype in ("jpeg", "webp") and len(inline_image_data) > 90_000:
                        try:
                            from PIL import Image
                            import io as _io
                            with Image.open(_io.BytesIO(inline_image_data)) as im:
                                im = im.convert("RGB")
                                w, h = im.size
                                # Ресайз по большей стороне до 1200px (для email хватает с запасом).
                                max_dim = 1200
                                if max(w, h) > max_dim:
                                    scale = max_dim / max(w, h)
                                    im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
                                # Понижаем quality пока не уложимся в 90KB или quality<55.
                                for q in (78, 70, 62, 55):
                                    buf = _io.BytesIO()
                                    im.save(buf, format="JPEG", quality=q, optimize=True, progressive=True)
                                    if buf.tell() <= 90_000 or q == 55:
                                        inline_image_data = buf.getvalue()
                                        inline_image_subtype = "jpeg"
                                        logger.info(
                                            f"Email broadcast: фото сжато до {len(inline_image_data)} байт (q={q})"
                                        )
                                        break
                        except Exception as e:
                            logger.warning(f"Email broadcast: ресайз фото не удался ({e}) — шлём как есть")
                else:
                    logger.warning(
                        f"Email broadcast: фото {photo_url} вернуло HTTP {resp.status_code} — "
                        f"вкладывать в письмо не будем, оставим как ссылку"
                    )
        except Exception as e:
            logger.warning(f"Email broadcast: не смог скачать фото {photo_url}: {e}")

        if inline_image_data:
            # Получилось скачать — встраиваем по CID.
            html_image = (
                f'<div style="margin-bottom:20px;">'
                f'<img src="cid:{inline_image_cid}" alt="" '
                f'style="display:block;max-width:100%;width:600px;height:auto;'
                f'border-radius:12px;border:0;outline:none;"/>'
                f'</div>'
            )
        else:
            # Не получилось — fallback на прямую ссылку (как раньше).
            html_image = (
                f'<div style="margin-bottom:20px;">'
                f'<img src="{photo_url}" alt="" '
                f'style="display:block;max-width:100%;width:600px;height:auto;'
                f'border-radius:12px;border:0;outline:none;"/>'
                f'</div>'
            )

    # ── Видео-обложка для email: первый кадр как кликабельная картинка ──
    # Telegram/VK играют видео сами; в email встроить нельзя — поэтому
    # показываем обложку (thumbnail) с иконкой play, вся картинка — ссылка на
    # видео (открывается в браузере). Обложку встраиваем по CID (как фото).
    html_video_cover = ""
    video_thumb_data: bytes | None = None
    video_thumb_cid: str = "broadcast_video_cover"
    if is_video_email:
        try:
            async with httpx.AsyncClient(timeout=60.0) as vf:
                vresp = await vf.get(video_url)
            if vresp.status_code == 200:
                from app.services.video_meta import extract_thumbnail
                video_thumb_data = await extract_thumbnail(vresp.content)
        except Exception as e:
            logger.warning(f"Email broadcast: не смог получить обложку видео {video_url}: {e}")
        # Кликабельная обложка с наложенной иконкой play (через таблицу-overlay
        # не делаем — почтовики капризны; кладём play как фоновую псевдо-кнопку
        # поверх через простой div поверх img в обёртке position:relative).
        cover_src = f"cid:{video_thumb_cid}" if video_thumb_data else None
        if cover_src:
            html_video_cover = (
                f'<a href="{video_url}" target="_blank" rel="noopener" '
                f'style="display:block;position:relative;margin-bottom:20px;text-decoration:none;">'
                f'<img src="{cover_src}" alt="Смотреть видео" '
                f'style="display:block;max-width:100%;width:600px;height:auto;'
                f'border-radius:12px;border:0;outline:none;"/>'
                f'<span style="position:absolute;top:50%;left:50%;'
                f'transform:translate(-50%,-50%);background:rgba(37,69,93,0.85);'
                f'color:#FFCFA4;width:64px;height:64px;border-radius:50%;'
                f'font-size:28px;line-height:64px;text-align:center;">&#9658;</span>'
                f'</a>'
                f'<div style="margin:-8px 0 20px;">'
                f'<a href="{video_url}" target="_blank" rel="noopener" '
                f'style="color:#3D8CB6;text-decoration:underline;font-size:14px;">▶ Смотреть видео</a>'
                f'</div>'
            )
        else:
            # Обложку извлечь не вышло — даём аккуратную кнопку-ссылку.
            html_video_cover = (
                f'<div style="margin-bottom:20px;">'
                f'<a href="{video_url}" target="_blank" rel="noopener" '
                f'style="display:inline-block;background-color:#25455D;color:#FFCFA4 !important;'
                f'padding:14px 28px;border-radius:12px;text-decoration:none;'
                f'font-family:Roboto,sans-serif;font-size:16px;font-weight:700;">▶ Смотреть видео</a>'
                f'</div>'
            )

    # HTML-кнопка: простой <a> с inline-стилем. Без <table> — Gmail
    # надёжнее рендерит и сохраняет href кликабельным.
    def _html_button(label: str, url: str) -> str:
        safe_label = (label or "Открыть").replace("<", "&lt;").replace(">", "&gt;")
        safe_url = (url or "#").replace('"', "")
        return (
            f'<div style="margin:28px 0;">'
            f'<a href="{safe_url}" target="_blank" rel="noopener" '
            f'style="display:inline-block;background-color:#FFCFA4;color:#25455D !important;'
            f'padding:14px 36px;border-radius:12px;text-decoration:none;'
            f'font-family:Roboto,-apple-system,sans-serif;font-size:16px;font-weight:700;'
            f'line-height:1;">{safe_label}</a>'
            f'</div>'
        )

    html_button = ""
    if button_text and button_url:
        html_button = _html_button(button_text, button_url)
    elif buttons:
        html_button = "".join(
            _html_button((b.get("text") or b.get("label") or "Открыть"), b.get("url", ""))
            for b in buttons
        )

    # Собираем полное HTML-тело — с doctype/html/body, иначе Gmail может
    # порезать стили и инлайн-ссылки превратить в plain.
    # Внешний фон страницы — белый, а сам контент письма (текст, картинка,
    # кнопка) лежит на светло-голубой плашке #E8F2FA. Подвал отписки потом
    # инжектится в email_sender ПОСЛЕ голубой плашки, на белом фоне.
    html_body = (
        '<!DOCTYPE html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '</head><body style="margin:0;padding:20px;background:#ffffff;">'
        f'<div style="font-family:Roboto,-apple-system,BlinkMacSystemFont,sans-serif;'
        f'font-size:15px;line-height:1.55;color:#25455D;max-width:640px;margin:0 auto;">'
        f'<div style="background:#E8F2FA;padding:30px 24px;border-radius:16px;">'
        f'{html_image}'
        f'{html_video_cover}'
        f'<div>{html_inner}</div>'
        f'{html_button}'
        f'</div>'
        f'</div></body></html>'
    )

    # Plain-часть: HTML вырезан + текстовая кнопка.
    body_text = _strip_html(raw_text)
    if is_video_email:
        body_text = body_text.rstrip() + f"\n\n▶ Смотреть видео: {video_url}"
    if button_text and button_url:
        body_text = body_text.rstrip() + f"\n\n{button_text}: {button_url}"
    elif buttons:
        body_text = body_text.rstrip() + "\n\n" + "\n".join(
            f"{(b.get('text') or b.get('label') or 'Открыть')}: {b.get('url','')}" for b in buttons
        )

    frontend_url = settings.frontend_url.rstrip("/")
    pixel_base = f"{frontend_url}/api/v1/email/pixel"
    click_base = f"{frontend_url}/api/v1/email/click"
    unsub_base = f"{frontend_url}/api/v1/email/unsubscribe"

    def _inject_tracking(html: str, open_token: str, click_token: str) -> str:
        """Вшивает в HTML письма:
        1) Перед </body> — <img> 1×1 пиксель открытия (cid:open-token).
        2) Все <a href="…"> (кроме ссылок на /api/v1/email/unsubscribe и cid:/mailto:)
           переписывает на click-redirect /api/v1/email/click?token=…&u=…
        """
        # 1. Пиксель открытия — добавляем перед </body> (или в конец если </body> нет).
        pixel = (
            f'<img src="{pixel_base}/{open_token}.gif" '
            f'width="1" height="1" alt="" '
            f'style="display:block;width:1px;height:1px;border:0;outline:none;"/>'
        )
        if "</body>" in html:
            html = html.replace("</body>", pixel + "</body>", 1)
        else:
            html = html + pixel

        # 2. Click rewriting. Регулярка ловит href="…" и href='…'. Пропускаем:
        #    - ссылки на /api/v1/email/unsubscribe (наш собственный unsub)
        #    - cid:, mailto:, tel:, data: — это не для трекинга
        def _rewrite(match):
            full = match.group(0)        # вся href="…" часть
            quote = match.group(1)       # " или '
            url = match.group(2)         # содержимое
            low = url.lower()
            if (
                "/api/v1/email/unsubscribe" in low
                or low.startswith(("cid:", "mailto:", "tel:", "data:", "#"))
            ):
                return full
            if not low.startswith(("http://", "https://")):
                return full
            encoded = _urlparse.quote(url, safe="")
            new_url = f"{click_base}?token={click_token}&u={encoded}"
            return f'href={quote}{new_url}{quote}'

        html = _re_tracking.sub(
            r'href\s*=\s*(["\'])([^"\']+)\1',
            _rewrite,
            html,
            flags=_re_tracking.IGNORECASE,
        )
        return html

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
        first_name_val = r["first_name"] or "друг"
        msg_text = body_text.replace("{first_name}", first_name_val) if "{first_name}" in body_text else body_text
        msg_html = (
            html_body.replace("{first_name}", first_name_val) if (html_body and "{first_name}" in html_body)
            else html_body
        )

        # 1) Вставляем broadcast_log со статусом 'sending' — нужен для трек-токенов.
        #    Полноценный sent/failed/error/external_message_id допишем после отправки.
        try:
            blid = await conn.fetchval(
                """INSERT INTO broadcast_log
                       (schedule_id, platform_user_id, channel_id, status, sent_at)
                   VALUES ($1, $2, $3, 'sending', NOW())
                   RETURNING id""",
                schedule["id"], r["pu_id"], channel_dict["channel_id"],
            )
        except Exception as e:
            logger.warning(f"Email broadcast_log insert (sending) failed for pu_id={r['pu_id']}: {e}")
            blid = None

        # 2) Если есть blid — вшиваем open-пиксель и click-rewriting в HTML.
        msg_html_final = msg_html
        if blid and msg_html_final:
            open_tok = make_open_token(blid, r["contact_id"])
            click_tok = make_click_token(blid, r["contact_id"])
            msg_html_final = _inject_tracking(msg_html_final, open_tok, click_tok)

        ok = False
        err: str | None = None
        msg_id: str | None = None
        # Если фото удалось скачать — передаём байты как inline-attachment,
        # на который ссылается <img src="cid:broadcast_image"> в html_body.
        # Аналогично — обложка видео (cid:broadcast_video_cover).
        inline_images_arg = None
        _imgs = []
        if inline_image_data:
            _imgs.append({
                "content_id": inline_image_cid,
                "data": inline_image_data,
                "subtype": inline_image_subtype,
            })
        if video_thumb_data:
            _imgs.append({
                "content_id": video_thumb_cid,
                "data": video_thumb_data,
                "subtype": "jpeg",
            })
        if _imgs:
            inline_images_arg = _imgs

        try:
            msg_id = sender.send(
                channel=channel_dict,
                client_brand_name=client_brand_name,
                to_email=email_addr,
                subject=subject,
                body_text=msg_text,
                unsubscribe_token=unsub_token,
                body_html=msg_html_final,
                inline_images=inline_images_arg,
                footer_brand_label=footer_brand_label,
            )
            ok = True
        except EmailSendError as e:
            err = str(e)

        # 3) Обновляем broadcast_log финальным статусом.
        if blid:
            try:
                await conn.execute(
                    """UPDATE broadcast_log
                          SET status = $2, error = $3, external_message_id = $4
                        WHERE id = $1""",
                    blid,
                    "sent" if ok else "failed",
                    err,
                    msg_id,
                )
            except Exception as e:
                logger.warning(f"Email broadcast_log update failed for blid={blid}: {e}")
        else:
            # Fallback на случай если первый INSERT не прошёл — пишем после отправки.
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
                logger.warning(f"Email broadcast_log insert (fallback) failed for pu_id={r['pu_id']}: {e}")

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
# отправки — удаляем такие фото из R2 + БД через 24 ЧАСА после завершения
# рассылки. 24 часа — это запас на:
#   - превью «Получатели рассылки» в первые часы после отправки,
#   - повторную отправку, если клиент тут же дублирует рассылку.
# Раньше было 10 минут — слишком агрессивно: email-получатели открывают
# письмо не сразу, и встроенный <img src="https://r2.dev/..."> отдавал 404.
# Сейчас в email мы делаем inline-картинку через CID, поэтому пожизненно
# хранить фото не нужно — 24 часа достаточно.
# Орфаны (загрузили в форме рассылки, но не отправили) — через час.
@celery.task(name="app.tasks.broadcast.cleanup_broadcast_photos")
def cleanup_broadcast_photos():
    run_async(_cleanup_broadcast_photos())


async def _cleanup_broadcast_photos():
    from app.services import r2_storage
    conn = await _get_conn()
    try:
        # 1. Медиа (фото/видео), использованные в произвольных рассылках, которые
        #    завершились (done/cancelled/paused_subscription_expired) > 24ч назад.
        #    Видео матчим по snapshot_video, фото — по snapshot_photo.
        #    ВАЖНО: НЕ удаляем медиа, на которое ссылается шаблон (broadcast_templates) —
        #    шаблонные видео/фото должны жить, пока шаблон существует.
        used_rows = await conn.fetch(
            """
            SELECT DISTINCT cf.id, cf.r2_key, cf.size_bytes, cf.client_id
              FROM client_files cf
              JOIN broadcast_schedules bs
                ON (cf.kind = 'broadcast_photo' AND bs.snapshot_photo = cf.url)
                OR (cf.kind = 'broadcast_video' AND bs.snapshot_video = cf.url)
             WHERE cf.kind IN ('broadcast_photo', 'broadcast_video')
               AND bs.status IN ('done', 'cancelled', 'paused_subscription_expired')
               AND bs.finished_at IS NOT NULL
               AND bs.finished_at < NOW() - INTERVAL '24 hours'
               AND NOT EXISTS (
                 SELECT 1 FROM broadcast_templates bt
                  WHERE bt.video_url = cf.url OR bt.photo_url = cf.url
               )
            """
        )

        # 2. Орфаны: загружены > 1 часа назад, не используются ни в рассылке, ни в шаблоне.
        orphan_rows = await conn.fetch(
            """
            SELECT cf.id, cf.r2_key, cf.size_bytes, cf.client_id
              FROM client_files cf
             WHERE cf.kind IN ('broadcast_photo', 'broadcast_video')
               AND cf.created_at < NOW() - INTERVAL '1 hour'
               AND NOT EXISTS (
                 SELECT 1 FROM broadcast_schedules bs
                  WHERE bs.snapshot_photo = cf.url OR bs.snapshot_video = cf.url
               )
               AND NOT EXISTS (
                 SELECT 1 FROM broadcast_templates bt
                  WHERE bt.video_url = cf.url OR bt.photo_url = cf.url
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
