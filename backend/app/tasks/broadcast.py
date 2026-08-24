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
import re
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


def _apply_first_name(text: str, name: str | None) -> str:
    """Подставить имя получателя вместо {first_name}.

    ⚠️ НИКАКИХ подстановок-заглушек вроде «друг». Имени нет — плейсхолдер
    убирается вместе с лишними пробелами и знаками препинания вокруг него,
    как это делается с остальными пустыми плейсхолдерами. Заглушка уходила
    реальным людям («Привет, друг!») в рассылке клиента — так с аудиторией
    не разговаривают, и клиент увидел это у себя на созвоне.
    """
    if not text or "{first_name}" not in text:
        return text
    nm = (name or "").strip()
    if nm:
        return text.replace("{first_name}", nm)
    # Убираем плейсхолдер вместе с прилипшей запятой. Разбор по случаям —
    # иначе получается мусор вроде «Привет!!» или « добрый день» с пробелом:
    #   «Привет, {first_name}!»              → «Привет!»
    #   «{first_name}, добрый день»          → «Добрый день»
    #   «Здравствуйте, {first_name}, рады»   → «Здравствуйте, рады»
    #   «Добрый день! {first_name}!»         → «Добрый день!»
    out = text
    # 1) запятая с обеих сторон — оставляем одну: «А, {ph}, Б» → «А, Б»
    out = re.sub(r",[ \t]*\{first_name\}[ \t]*,", ",", out)
    # 2) знак препинания слева + плейсхолдер со своим знаком справа:
    #    «Привет! {ph}!» → «Привет!»   «Привет, {ph}!» → «Привет!»
    out = re.sub(r"([!?.…])[ \t]*\{first_name\}[ \t]*[!?.…]", r"\1", out)
    out = re.sub(r",[ \t]*\{first_name\}[ \t]*([!?.…])", r"\1", out)
    # 3) запятая слева: «Привет, {ph}» → «Привет»
    out = re.sub(r"[ \t]*,[ \t]*\{first_name\}", "", out)
    # 4) плейсхолдер в начале строки со своей запятой: «{ph}, текст» → «Текст»
    out = re.sub(r"^[ \t]*\{first_name\}[ \t]*,[ \t]*(.)",
                 lambda m: m.group(1).upper(), out, flags=re.MULTILINE)
    # 5) плейсхолдер перед знаком препинания: «{ph}!» → «!», «Дорогой {ph},» → «Дорогой,»
    out = re.sub(r"[ \t]*\{first_name\}[ \t]*(?=[!?.,;:…])", "", out)
    # 6) всё остальное — вырезаем вместе с прилипшими пробелами
    out = re.sub(r"[ \t]*\{first_name\}[ \t]*", " ", out)
    # Хвосты: двойные пробелы, пробел перед знаком, знак в начале строки.
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"[ \t]+([!?.,;:…])", r"\1", out)
    out = re.sub(r"^[ \t]*([,;:!?.…][ \t]*)+", "", out, flags=re.MULTILINE)
    return "\n".join(ln.rstrip() for ln in out.split("\n"))


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
            SELECT bs.*, COALESCE(bs.client_id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=e.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1)) AS client_id,
                   COALESCE(bs.audience_include, 'all_event') as audience_include,
                   COALESCE(bs.audience_exclude, 'none') as audience_exclude,
                   e.is_collab AS ev_is_collab,
                   e.module_slug AS ev_module_slug,
                   (e.status = 'ended' OR (e.end_at IS NOT NULL AND e.end_at < NOW())) AS ev_ended
            FROM broadcast_schedules bs
            LEFT JOIN events e ON e.id = bs.event_id
            WHERE bs.id = $1
            """,
            schedule_id
        )
        if not schedule:
            return

        # 🚫 КОЛЛАБ: в ЗАВЕРШЁННОЕ событие рассылки соорганизаторам не уходят.
        # «Завершено» = статус ended ИЛИ прошла дата окончания. Копия соорганизатора
        # опознаётся по origin_client_id (её поставил другой организатор по чужой базе).
        # Собственные рассылки владельца события этим НЕ режем — только фанаут-копии.
        if schedule["ev_is_collab"] and schedule["origin_client_id"] is not None and schedule["ev_ended"]:
            await conn.execute(
                "UPDATE broadcast_schedules SET status='cancelled', "
                "error_log='Событие завершено — рассылка соорганизаторам не отправлена', "
                "finished_at=NOW() WHERE id=$1",
                schedule_id,
            )
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

        # 🚫 Спикерские рассылки (за 5 минут до выступления, знакомство со
        # спикером, подарок, итоги дня) существуют только благодаря платному
        # модулю «Конференции»/«Премии и Турниры». Без него они не уходят.
        #
        # ⚠️ Проверяем И тип, И module_slug события: типы 5min_before и
        # day_live доступны и обычным мероприятиям — гейт только по типу
        # остановил бы рассылки тем, кто ничего не должен.
        #
        # Статус 'cancelled' с понятной причиной, а не тихий пропуск: клиент
        # должен видеть в очереди, почему рассылка не ушла, и иметь возможность
        # запустить её снова после оплаты.
        from app.services.module_access import broadcast_blocked_by_module
        _blocked = await broadcast_blocked_by_module(
            conn,
            client_id=client_id_for_check,
            module_slug=schedule.get("ev_module_slug"),
            broadcast_type=tpl_type,
        )
        if _blocked:
            logger.info("Рассылка %s не отправлена: %s", schedule_id, _blocked)
            await conn.execute(
                "UPDATE broadcast_schedules SET status='cancelled', error_log=$2, "
                "finished_at=NOW() WHERE id=$1",
                schedule_id, _blocked,
            )
            return

        # Читаем шаблон отдельным свежим запросом — максимально близко к отправке,
        # чтобы правки шаблона применились даже если очередь уже активирована
        tmpl = await conn.fetchrow(
            "SELECT subject, text, photo_url, video_url, media_type, video_file_id, "
            "button_text, button_url, target_channel_ids, speaker_photo_mode, "
            "send_to_event_chats, send_to_client_chats, send_to_private_chats "
            "FROM broadcast_templates WHERE id=$1",
            schedule["template_id"]
        ) if schedule["template_id"] else None

        # Флаги «слать в чаты» наследуются от шаблона, если в schedule не заданы
        # явно (как target_channel_ids). Так авто-сгенерированные schedule
        # подхватывают актуальное значение шаблона в момент отправки.
        # ⚠️ НО: если рассылку РЕДАКТИРОВАЛИ вручную (chats_overridden=TRUE,
        # миграция 235) — берём галочки СТРОГО из рассылки, шаблон НЕ подмешиваем.
        # Иначе снятую в рассылке галочку возвращал бы шаблон (был баг).
        if tmpl is not None and not schedule.get("chats_overridden"):
            if not schedule.get("send_to_event_chats") and tmpl["send_to_event_chats"]:
                schedule = dict(schedule); schedule["send_to_event_chats"] = True
            if not schedule.get("send_to_client_chats") and tmpl["send_to_client_chats"]:
                schedule = dict(schedule); schedule["send_to_client_chats"] = True
            if not schedule.get("send_to_private_chats") and tmpl["send_to_private_chats"]:
                schedule = dict(schedule); schedule["send_to_private_chats"] = True

        # Гейт по фиче: отправка в ОБЩИЕ/ЛИЧНЫЕ чаты клиента (база client_broadcast_chats)
        # доступна только с фичей broadcast_chats (Экстра/vip). У Профи и ниже эти флаги
        # игнорируются — даже если проставлены в БД (через bulk/API/старую запись).
        # «В чаты СОБЫТИЯ» (send_to_event_chats) — доступно всем, НЕ трогаем.
        if schedule.get("send_to_client_chats") or schedule.get("send_to_private_chats"):
            from app.services.features import client_has_feature
            if not await client_has_feature(conn, schedule["client_id"], "broadcast_chats"):
                schedule = dict(schedule)
                schedule["send_to_client_chats"] = False
                schedule["send_to_private_chats"] = False

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
        # Системный @pluson_bot как 3-й уровень fallback убран: если у клиента нет
        # своего TG-бота — TG-часть рассылки просто пропускается (default_bot_token=None),
        # а VK/MAX/email-части ниже отрабатывают как обычно. Раньше тут стоял
        # cancel-and-return, который убивал ВСЮ рассылку — это поведение тоже убрано.

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
            speaker_photo_mode=(tmpl["speaker_photo_mode"] if tmpl else "poster") or "poster",
            subject=tmpl_subject_val,
            explicit_day=schedule.get("day"),
        )

        text = content["text"]
        photo_url = content["photo"]
        video_url = content.get("video")
        media_type = content.get("media_type")
        button_text = content.get("button_text")
        button_url = content.get("button_url")
        buttons = content.get("buttons") or None

        # ── Снимок реально отправляемого сообщения ──────────────────────────────
        # Для шаблонных рассылок текст собирается из ТЕКУЩЕГО шаблона на лету и
        # раньше нигде не сохранялся. Если организатор потом правил шаблон — в
        # списке/превью отправленной рассылки показывался новый текст и сырые
        # плейсхолдеры в теме ({speaker_topic} и т.п.), а не то, что реально ушло.
        # Фиксируем собранный content в snapshot_* прямо перед отправкой, чтобы
        # у отправленной рассылки навсегда остался реальный текст и тема.
        # (Для type='custom' snapshot и так уже заполнен своим содержимым — не портим.)
        if tpl_type != "custom":
            try:
                import json as _json_snap
                await conn.execute(
                    """
                    UPDATE broadcast_schedules
                       SET snapshot_text = $1,
                           snapshot_subject = $2,
                           snapshot_photo = $3,
                           snapshot_video = $4,
                           snapshot_media_type = $5,
                           snapshot_btn_text = $6,
                           snapshot_btn_url = $7,
                           snapshot_buttons = $8
                     WHERE id = $9
                    """,
                    text,
                    content.get("subject"),
                    photo_url,
                    video_url,
                    media_type,
                    button_text,
                    button_url,
                    _json_snap.dumps(buttons) if buttons else None,
                    schedule_id,
                )
            except Exception as _snap_ex:
                logger.warning(f"Не удалось сохранить snapshot рассылки {schedule_id}: {_snap_ex}")

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

        # Заголовок (subject) — для TG/VK/MAX первой жирной строкой, для email — тема.
        # content["subject"] уже с подставленными {speaker_name}/{brand_name} (для
        # speaker-типов). Приоритет: резолвнутый из content → иначе сырой tmpl_subject_val.
        subject_val = (content.get("subject") or tmpl_subject_val or "").strip()
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
                SELECT pu.platform_user_id, COALESCE(NULLIF(pu.first_name, ''), '') AS first_name
                FROM platform_users pu
                JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE c_own.client_id=$1 AND pu.platform_slug='telegram' AND pu.platform_user_id = ANY($2::text[])
                """,
                schedule["client_id"], list(final_ids)
            )
            name_by_tg = {r["platform_user_id"]: r["first_name"] for r in name_rows}

        # {support_link} — контакт службы поддержки ТОЙ площадки, куда уходит
        # сообщение (в Telegram — телеграм-поддержка, в VK — VK, в MAX — MAX).
        # Текст рассылки собирается один раз на все платформы, поэтому подстановка
        # делается в момент отправки в каждую платформу — как {first_name}.
        # {support_platform} — единое имя плейсхолдера службы заботы по площадке
        # (как в воронках лид-магнитов). {support_link} — старое имя, принимаем его
        # тоже, чтобы не сломать уже настроенные шаблоны.
        # Два РАЗНЫХ плейсхолдера (как в воронках лид-магнитов, единые функции):
        #   {support_platform}/{support_link} — ОДИН контакт по площадке получателя;
        #   {support_links}                   — ВСЯ куча контактов (ВК/ТГ/MAX) списком.
        needs_support_one = ("{support_platform}" in (text or "")) or ("{support_link}" in (text or ""))
        needs_support_all = "{support_links}" in (text or "")
        needs_support_link = needs_support_one or needs_support_all
        # {support_command} — URL-плейсхолдер КНОПКИ «Тех.поддержка»: deeplink,
        # клик по которому вызывает команду support в боте (сообщение со всеми
        # каналами связи). Резолвится в deeplink ПО ПЛОЩАДКЕ получателя.
        needs_support_cmd = ("{support_command}" in (text or "")) or ("{support_command}" in (button_url or ""))
        # {signup_link} — регистрация в боте ПЛОЩАДКИ ПОЛУЧАТЕЛЯ (deeplink evsignup_).
        needs_signup = ("{signup_link}" in (text or "")) or ("{signup_link}" in (button_url or ""))
        signup_by_platform: dict[str, str] = {}
        signup_btn_by_platform: dict[str, str] = {}
        support_by_platform: dict[str, str] = {}
        support_all_block = ""
        support_cmd_by_platform: dict[str, str] = {}
        if needs_support_link:
            from app.services.support_message import support_url_for_platform, support_links_block
            sup_row = await conn.fetchrow(
                "SELECT work_tg_username, work_vk, work_max FROM clients WHERE id=$1",
                schedule["client_id"]
            )
            _wt = sup_row["work_tg_username"] if sup_row else None
            _wv = sup_row["work_vk"] if sup_row else None
            _wm = sup_row["work_max"] if sup_row else None
            for _p in ("telegram", "vk", "max", "email"):
                support_by_platform[_p] = support_url_for_platform(_p, _wt, _wv, _wm) if sup_row else ""
            if needs_support_all:
                support_all_block = support_links_block(_wt, _wv, _wm) if sup_row else ""
        if needs_support_cmd and schedule.get("event_id"):
            from app.services.share_links import get_client_bot_handles, build_support_command_links
            _handles = await get_client_bot_handles(conn, schedule["client_id"])
            _cmd = build_support_command_links(_handles, schedule["event_id"])
            support_cmd_by_platform = {
                "telegram": _cmd["telegram"], "vk": _cmd["vk"], "max": _cmd["max"], "email": _cmd["telegram"],
            }
        if needs_signup and schedule.get("event_id"):
            from app.services.share_links import (
                get_client_bot_handles, build_event_signup_links, pick_signup_link,
                get_event_disabled_platforms,
            )
            from app.services.message_builder import resolve_landing_url
            _sh = await get_client_bot_handles(conn, schedule["client_id"])
            # ⚠️ Ссылка строится по SLUG события (ref_pg{slug}), а не по его
            # номеру: обработчика /start evsignup_{id} в ботах нет.
            _eslug = await conn.fetchval(
                "SELECT slug FROM events WHERE id = $1", schedule["event_id"])
            _slinks = build_event_signup_links(_sh, _eslug or "")
            # Площадки, выключенные у события (миграция 263) — как будто бота нет:
            # сработает приоритет подмены (из ВК уводим в MAX).
            for _p in await get_event_disabled_platforms(conn, event_id=schedule["event_id"]):
                _slinks[_p] = ""
            _web = await resolve_landing_url(conn, schedule["event_id"])
            from app.services.share_links import pick_single_link
            # В ТЕКСТЕ: своя площадка → она; нет своей → ВСЕ имеющиеся с подписью
            # «Через Телеграм»/«Через МАКС» (иначе часть людей получит ссылку в
            # мессенджер, которым не пользуется).
            signup_by_platform = {
                p: pick_signup_link(_slinks, p, _web)
                for p in ("telegram", "vk", "max", "email")
            }
            # В КНОПКЕ: строго ОДИН адрес — многострочный список Telegram отвергает
            # («inline keyboard button URL is invalid»), и не доходит всё сообщение.
            signup_btn_by_platform = {
                p: pick_single_link(_slinks, p, _web)
                for p in ("telegram", "vk", "max", "email")
            }

        def _with_support(txt: str | None, platform: str, *, as_url: bool = False) -> str:
            """{support_platform}/{support_link} → ОДИН контакт по площадке;
            {support_links} → ВСЯ куча списком; {support_command} → deeplink-кнопка
            вызова команды support. Единый резолв (support_message.py / share_links).

            as_url=True — подставляем в АДРЕС КНОПКИ: там допустим ровно один URL,
            поэтому {signup_link} резолвится одной ссылкой, а не списком площадок."""
            if not txt:
                return txt or ""
            if needs_support_link:
                val = support_by_platform.get(platform, "")
                txt = (txt.replace("{support_links}", support_all_block)
                          .replace("{support_platform}", val).replace("{support_link}", val))
            if needs_support_cmd:
                txt = txt.replace("{support_command}", support_cmd_by_platform.get(platform, ""))
            if needs_signup:
                _smap = signup_btn_by_platform if as_url else signup_by_platform
                txt = txt.replace("{signup_link}", _smap.get(platform, ""))
            return txt

        def _clean_url(u: str) -> str:
            """⚠️ Telegram отвергает адрес кнопки с пробелом или переводом
            строки («Bad Request: inline keyboard button URL is invalid»), а
            в шаблоне после плейсхолдера легко остаётся лишний пробел — тогда
            не доходит ВСЁ сообщение, а не только кнопка."""
            return (u or "").strip()

        # ── Ссылки на воронку подарков-лид-магнитов ⟦GF:m|p:slug⟧ ──────────────
        # Подарок-лид-магнит/пакет ПЛЮСОНа в тексте помечен токеном ⟦GF:kind:slug⟧
        # (kind = m|p). Прямой файл в рассылку НЕ уходит — он выдаётся воронкой за
        # подписку. Здесь токен заменяется ПЛАТФОРМЕННОЙ ссылкой на воронку через
        # VIP-бот клиента, с приоритетом по площадке получателя:
        #   MAX-рассылка → max > vk > telegram
        #   VK-рассылка  → vk > max > telegram
        #   TG-рассылка  → telegram > max > vk
        # Если у клиента нет бота на приоритетной площадке — берём следующую по
        # приоритету из подключённых (build_funnel_landing_links вернёт только те).
        from app.services.share_links import (
            GIFT_FUNNEL_TOKEN_RE as _GF_TOKEN,
            build_gift_funnel_links_by_owner,
            pick_gift_funnel_link,
        )
        _gf_slugs = set()
        for _txt in (text, button_url):
            for _m in _GF_TOKEN.finditer(_txt or ""):
                _gf_slugs.add((_m.group(1), _m.group(2)))
        # (kind, slug) → {telegram?, vk?, max?}. Резолвим ОДИН раз на всю аудиторию
        # (запрос в БД — не гоняем на каждого получателя).
        #
        # ⚠️ Ссылка строится по каналам ХОЗЯИНА магнита (lead_magnets/lead_magnet_packages
        # .client_id по slug), а НЕ отправителя рассылки: воронка живёт в базе хозяина,
        # в чужом боте её нет. Площадку по-прежнему диктует отправитель (ниже,
        # pick_gift_funnel_link по площадке получателя).
        _gf_links: dict[tuple[str, str], dict] = {}
        for _kind, _slug in _gf_slugs:
            _gf_links[(_kind, _slug)] = await build_gift_funnel_links_by_owner(conn, _kind, _slug)

        def _with_gift_funnel(txt: str | None, platform: str, *, as_url: bool = False) -> str:
            """Заменить токены ⟦GF:kind:slug⟧ ссылкой на воронку нужной площадки.

            В ТЕКСТЕ: своей площадки у хозяина магнита нет → перечисляем ВСЕ его
            площадки с подписью «Через Телеграм»/«Через МАКС» (pick_gift_funnel_link).
            В КНОПКЕ (as_url=True): строго ОДИН адрес — список Telegram отвергает."""
            if not txt or not _gf_slugs:
                return txt or ""
            from app.services.share_links import pick_single_link as _pick_one

            def _sub(m):
                links = _gf_links.get((m.group(1), m.group(2))) or {}
                return _pick_one(links, platform) if as_url else pick_gift_funnel_link(links, platform)
            return _GF_TOKEN.sub(_sub, txt)

        def _with_platform_subst(txt: str | None, platform: str) -> str:
            """Обе площадко-зависимые подстановки разом: служба заботы + ссылка
            воронки подарка. Передаётся в хелперы чатов вместо голого _with_support."""
            return _with_gift_funnel(_with_support(txt, platform), platform)

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
            # Системный @pluson_bot как fallback убран: без своего бота клиента
            # {game_link} вести некуда — оставляем ссылку пустой (плейсхолдер
            # подставится пустотой, кнопка/текст без рабочей ссылки на этой платформе).
            if bot_handle:
                game_link_url = f"https://telegram.me/{bot_handle}?startapp=ref_pg{event_slug_for_glink}_tabgame"
            else:
                game_link_url = ""

        # Персональный сквозной маркер контакта `_ct{contact_id}` в {game_link}.
        # При клике на чужой платформе человек привяжется к своему контакту,
        # а не создаст дубль. Мапа tg_id → contact_id для получателей-телеграмеров;
        # если contact_id неизвестен — используем общий game_link_url (как раньше).
        # Ссылка эфира несёт хвост ?c=__CT__ (см. day_stream_url в рассылке) —
        # per-получатель подставим реальный contact_id (или уберём хвост).
        needs_stream_ct = "__CT__" in (text or "") or "__CT__" in (button_url or "")
        contact_by_tg: dict[str, int] = {}
        if (needs_game_link or needs_stream_ct) and final_ids:
            ct_rows = await conn.fetch(
                """SELECT pu.platform_user_id, pu.contact_id
                     FROM platform_users pu
                     JOIN contacts c_own ON c_own.id = pu.contact_id
                    WHERE c_own.client_id=$1 AND pu.platform_slug='telegram'
                      AND pu.platform_user_id = ANY($2::text[])""",
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
                # Легаси-контакт без записи в platform_user_channels — fallback на главный
                # канал клиента. Если у клиента нет своего TG-бота (default_bot_token=None) —
                # отправить таким нечем (системный @pluson_bot как fallback убран), пропускаем.
                if not default_bot_token:
                    continue
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
                msg_text = _with_gift_funnel(_with_support(text, "telegram"), "telegram")
                msg_btn_url = _clean_url(_with_gift_funnel(_with_support(button_url, "telegram", as_url=True), "telegram", as_url=True))
                if needs_first_name:
                    msg_text = _apply_first_name(msg_text, name_by_tg.get(tg_id))
                if needs_game_link:
                    # Персональная ссылка с `_ct{contact_id}` если контакт известен,
                    # иначе общая game_link_url (обратная совместимость).
                    ct = contact_by_tg.get(tg_id)
                    glink = f"{game_link_url}_ct{ct}" if ct else game_link_url
                    msg_text = msg_text.replace("{game_link}", glink)
                    if msg_btn_url:
                        msg_btn_url = msg_btn_url.replace("{game_link}", glink)
                if needs_stream_ct:
                    # ?c=__CT__ в ссылке эфира → реальный contact_id получателя,
                    # либо убираем хвост, если контакт неизвестен.
                    ctv = contact_by_tg.get(tg_id)
                    msg_text = msg_text.replace("?c=__CT__", f"?c={ctv}" if ctv else "")
                    if msg_btn_url:
                        msg_btn_url = msg_btn_url.replace("?c=__CT__", f"?c={ctv}" if ctv else "")
                # Собираем message_id отправленных сообщений — чтобы потом можно было
                # удалить их (отзыв рассылки). У одного получателя может быть 2 (фото/видео + текст).
                msg_ids: list[int] = []
                ok, err = await send_telegram_message(
                    http_client, token, tg_id, msg_text, photo_url, button_text, msg_btn_url,
                    buttons=buttons,
                    video_url=video_url if media_type == "video" else None,
                    video_file_id=_vid_fid_holder["fid"] if media_type == "video" else None,
                    on_video_file_id=_capture_video_file_id if media_type == "video" else None,
                    on_message_id=lambda mid: msg_ids.append(mid),
                )
                return tg_id, channel_id, (ok, err, msg_ids)

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
        for tg_id, channel_id, (success, tg_error, msg_ids) in results:
            is_blocked = not success and tg_error and any(e in tg_error.lower() for e in BLOCKED_ERRORS)
            # external_message_id = message_id(ы) отправленных сообщений через запятую —
            # нужно для отзыва рассылки (deleteMessage). Пусто если id не получен.
            ext_mid = ",".join(str(m) for m in msg_ids) if msg_ids else None
            await conn.execute(
                """
                INSERT INTO broadcast_log (schedule_id, platform_user_id, channel_id, status, error, external_message_id, sent_at)
                SELECT $1, pu.id, $6, $2, $3, $7, NOW()
                FROM platform_users pu
                JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE pu.platform_slug = 'telegram' AND pu.platform_user_id = $4 AND c_own.client_id = $5
                """,
                schedule_id,
                "sent" if success else "failed",
                tg_error or None,
                tg_id,
                schedule["client_id"],
                channel_id,
                ext_mid,
            )
            if is_blocked:
                # Помечаем отписавшимся в КОНКРЕТНОМ канале через который слали.
                # Если канала не было (легаси) — отметим в главном.
                await mark_unsubscribed_by_tg_id(
                    schedule["client_id"], tg_id, conn, channel_id=channel_id
                )
            if success:
                sent += 1

        # Отправка копии в групповые TG-чаты — две независимые галочки:
        #   send_to_event_chats   → чат СОБЫТИЯ (events.tg_chat_id);
        #   send_to_client_chats  → общая база чатов клиента (client_broadcast_chats, platform='telegram').
        # Дедуп: ведём общий set отправленных chat_id (sent_tg_chats), чтобы один и
        # тот же чат не получил сообщение дважды (если он и чат события, и в базе).
        # ⚠️ Не для теста (is_test) — тест не спамит реальные групповые чаты.
        # Без своего TG-бота (default_bot_token=None) в групповые TG-чаты слать нечем —
        # системный @pluson_bot как fallback убран.
        sent_tg_chats: set[str] = set()
        if not schedule["is_test"] and default_bot_token:
            tg_chats: list[tuple[str, str]] = []  # (chat_id, chat_kind)
            if schedule.get("send_to_event_chats") and event_id:
                # Чат события TG — через ref на client_broadcast_chats.
                ev_tg = await conn.fetchval(
                    """SELECT cbc.chat_id FROM events e
                         JOIN client_broadcast_chats cbc ON cbc.id = e.tg_chat_ref
                        WHERE e.id = $1""", event_id)
                if ev_tg and str(ev_tg).strip():
                    tg_chats.append((str(ev_tg).strip(), "event"))
            if schedule.get("send_to_client_chats"):
                # ОБЩИЕ чаты: is_private = FALSE
                rows_cl = await conn.fetch(
                    """SELECT chat_id FROM client_broadcast_chats
                        WHERE client_id = $1 AND platform = 'telegram' AND is_active = TRUE
                          AND use_for_broadcasts = TRUE AND is_private = FALSE""",
                    schedule["client_id"],
                )
                tg_chats += [(str(r["chat_id"]).strip(), "client_common") for r in rows_cl if r["chat_id"]]
            if schedule.get("send_to_private_chats"):
                # ЛИЧНЫЕ каналы: is_private = TRUE
                rows_pr = await conn.fetch(
                    """SELECT chat_id FROM client_broadcast_chats
                        WHERE client_id = $1 AND platform = 'telegram' AND is_active = TRUE
                          AND use_for_broadcasts = TRUE AND is_private = TRUE""",
                    schedule["client_id"],
                )
                tg_chats += [(str(r["chat_id"]).strip(), "client_private") for r in rows_pr if r["chat_id"]]
            if tg_chats:
                async with httpx.AsyncClient(timeout=15) as http_extra:
                    for cid, ckind in tg_chats:
                        if not cid or cid in sent_tg_chats:
                            continue
                        sent_tg_chats.add(cid)
                        try:
                            _chat_mids: list[int] = []
                            ok, err = await send_telegram_message(
                                http_extra, default_bot_token, cid,
                                _with_gift_funnel(_with_support(text, "telegram"), "telegram"),
                                photo_url, button_text,
                                _clean_url(_with_gift_funnel(_with_support(button_url, "telegram", as_url=True), "telegram", as_url=True)),
                                buttons=buttons,
                                video_url=video_url if media_type == "video" else None,
                                on_message_id=lambda mid: _chat_mids.append(mid),
                            )
                            ext_mid = ",".join(str(m) for m in _chat_mids) if _chat_mids else None
                            await _log_chat_send(conn, schedule_id, ckind, "telegram", cid, ok,
                                                 error=(err or None), external_message_id=ext_mid)
                        except Exception as ex:
                            await _log_chat_send(conn, schedule_id, ckind, "telegram", cid, False, str(ex))
                            logger.warning(f"TG-чат {cid} для рассылки {schedule_id} упал: {ex}")

        # === VK подписчики (доп. слой, после TG) ===
        # Шлём VK-подписчикам клиента ту же рассылку через VK API messages.send.
        # Контакты учитываются отдельно: один человек может быть в TG-базе И VK-базе одновременно —
        # получит сообщение в обоих местах (это норма, см. CLAUDE.md «один контакт в нескольких контекстах»).
        try:
            vk_sent = await _send_broadcast_vk_part(
                conn, schedule, event_id,
                _with_gift_funnel(_with_support(text, "vk"), "vk"),
                photo_url, button_text, _clean_url(_with_gift_funnel(_with_support(button_url, "vk", as_url=True), "vk", as_url=True)),
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
                conn, schedule, event_id,
                _with_gift_funnel(_with_support(text, "max"), "max"),
                photo_url, button_text, _clean_url(_with_gift_funnel(_with_support(button_url, "max", as_url=True), "max", as_url=True)),
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
                conn, schedule, event_id,
                _with_gift_funnel(_with_support(text_for_email, "email"), "email"),
                photo_url, button_text, _clean_url(_with_gift_funnel(_with_support(button_url, "email", as_url=True), "email", as_url=True)),
                buttons=buttons, target_channel_set=target_channel_set,
                subject_override=subject_val or None,
                video_url=video_url, media_type=media_type,
            )
            sent += email_sent
            logger.info(f"Email-часть рассылки {schedule_id}: отправлено {email_sent}")
        except Exception as ex:
            logger.warning(f"Email-часть рассылки {schedule_id} упала: {ex}")

        # === Групповые чаты события (доп. слой) ===
        # Если у шаблона/расписания стоит флаг send_to_event_chats — в ДОПОЛНЕНИЕ
        # к базе шлём сообщение ещё и в групповые чаты события: events.tg_chat_id /
        # vk_chat_id / max_chat_id (по платформам, у которых чат задан).
        # ⚠️ При тестовой рассылке (is_test) в чаты НЕ шлём — тест только на
        # тестовые ID, чтобы не спамить реальные групповые чаты события.
        # Дедуп VK/MAX между чатами события и базой чатов клиента — общий set.
        _sent_vk: set = set()
        _sent_max: set = set()
        if schedule.get("send_to_event_chats") and event_id and not schedule.get("is_test"):
            try:
                chats_sent = await _send_broadcast_to_event_chats(
                    conn, schedule, event_id, text, photo_url, button_text, button_url,
                    buttons=buttons, video_url=video_url, media_type=media_type,
                    sent_vk=_sent_vk, sent_max=_sent_max, with_support=_with_platform_subst,
                )
                sent += chats_sent
                logger.info(f"Чаты события для рассылки {schedule_id}: отправлено {chats_sent}")
            except Exception as ex:
                logger.warning(f"Отправка в чаты события для рассылки {schedule_id} упала: {ex}")

        # === Общие чаты клиента (доп. слой) — VK/MAX, по флагу send_to_client_chats ===
        # TG-чаты этой базы уже ушли в общем TG-блоке выше (с дедупом).
        # is_private=FALSE — общие чаты.
        if schedule.get("send_to_client_chats") and not schedule.get("is_test"):
            try:
                cl_sent = await _send_broadcast_to_client_chats(
                    conn, schedule, text, photo_url, button_text, button_url,
                    buttons=buttons, video_url=video_url, media_type=media_type,
                    sent_vk=_sent_vk, sent_max=_sent_max, is_private=False, with_support=_with_platform_subst,
                )
                sent += cl_sent
                logger.info(f"Общие чаты клиента для рассылки {schedule_id}: отправлено {cl_sent}")
            except Exception as ex:
                logger.warning(f"Отправка в общие чаты клиента для рассылки {schedule_id} упала: {ex}")

        # === Личные каналы клиента (доп. слой) — VK/MAX, по флагу send_to_private_chats ===
        # is_private=TRUE. Дедуп общий с чатами события и общими чатами (_sent_vk/_sent_max).
        if schedule.get("send_to_private_chats") and not schedule.get("is_test"):
            try:
                pr_sent = await _send_broadcast_to_client_chats(
                    conn, schedule, text, photo_url, button_text, button_url,
                    buttons=buttons, video_url=video_url, media_type=media_type,
                    sent_vk=_sent_vk, sent_max=_sent_max, is_private=True, with_support=_with_platform_subst,
                )
                sent += pr_sent
                logger.info(f"Личные каналы клиента для рассылки {schedule_id}: отправлено {pr_sent}")
            except Exception as ex:
                logger.warning(f"Отправка в личные каналы клиента для рассылки {schedule_id} упала: {ex}")

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


async def _log_chat_send(conn, schedule_id: int, kind: str, platform: str,
                         chat_ref: str, ok: bool, error: str | None = None,
                         chat_title: str | None = None,
                         external_message_id: str | None = None) -> None:
    """Записать доставку в ЧАТ в broadcast_log (миграция 220). Отдельно от личных
    отправок: platform_user_id=NULL, вид/платформа/чат в chat_* полях.
    external_message_id — message_id(ы) для последующего отзыва (deleteMessage)."""
    try:
        await conn.execute(
            """INSERT INTO broadcast_log
                 (schedule_id, platform_user_id, status, error, chat_kind, chat_platform, chat_ref, chat_title, external_message_id)
               VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8)""",
            schedule_id, ("sent" if ok else "failed"), (None if ok else (error or "не доставлено")),
            kind, platform, str(chat_ref), chat_title, external_message_id,
        )
    except Exception as e:
        logger.warning(f"broadcast_log chat insert failed (sch={schedule_id}, {platform}/{chat_ref}): {e}")


async def _send_broadcast_to_event_chats(
    conn, schedule, event_id: int,
    text: str, photo_url: str | None, button_text: str | None, button_url: str | None,
    buttons: list | None = None,
    video_url: str | None = None, media_type: str | None = None,
    sent_vk: set | None = None, sent_max: set | None = None,
    with_support=None,
) -> int:
    """Шлёт рассылку в ГРУППОВЫЕ чаты события VK/MAX (по флагу send_to_event_chats):
    events.vk_chat_id (VK-беседа), max_chat_id (MAX-чат).
    Telegram-чаты обрабатываются отдельно выше (с дедупом),
    поэтому ЗДЕСЬ TG НЕ дублируем. Возвращает число успешно отправленных чатов.
    В sent_vk/sent_max (если переданы) регистрирует отправленные chat_id —
    для дедупа с базой чатов клиента."""
    # Чаты события VK/MAX — через ref на client_broadcast_chats.
    ev = await conn.fetchrow(
        """SELECT (SELECT chat_id FROM client_broadcast_chats WHERE id = e.vk_chat_ref) AS vk_chat_id,
                  (SELECT chat_id FROM client_broadcast_chats WHERE id = e.max_chat_ref) AS max_chat_id
             FROM events e WHERE e.id = $1""", event_id
    )
    if not ev:
        return 0
    client_id = schedule["client_id"]
    sent = 0

    # ── MAX-чат ──
    max_chat = (ev["max_chat_id"] or "").strip() if ev["max_chat_id"] else ""
    if max_chat:
        try:
            from app.services.max_api import send_message as max_send, tg_inline_to_max_keyboard, upload_media as max_upload_media
            from app.services.message_builder import html_to_telegram
            from app.config import settings as _settings
            max_token = await conn.fetchval(
                """SELECT ch.bot_token FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id=$1 AND cc.is_active=TRUE AND ch.platform_slug='max'
                      AND ch.is_system=FALSE AND ch.bot_token IS NOT NULL AND ch.bot_token<>''
                    LIMIT 1""",
                client_id,
            ) or _settings.max_system_bot_token
            if max_token:
                max_buttons = None
                if buttons:
                    rows_btn = [[{"text": (b.get("text") or b.get("label") or "Открыть"), "url": b.get("url", "")}] for b in buttons]
                    max_buttons = tg_inline_to_max_keyboard(rows_btn)
                elif button_text and button_url:
                    max_buttons = tg_inline_to_max_keyboard([[{"text": button_text, "url": button_url}]])
                # {support_link} → контакт поддержки MAX (в чат события уходит MAX).
                _txt = with_support(text, "max") if with_support else (text or "")
                msg = html_to_telegram(_txt or "")
                attach = None
                if photo_url and media_type != "video":
                    import tempfile, os as _os
                    async with httpx.AsyncClient(timeout=60.0) as _cli:
                        _img = await _cli.get(photo_url)
                    if _img.status_code == 200 and _img.content:
                        _tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
                        try:
                            _tmp.write(_img.content); _tmp.flush(); _tmp.close()
                            attach = await max_upload_media(_tmp.name, token=max_token, kind="image")
                        finally:
                            try: _os.unlink(_tmp.name)
                            except OSError: pass
                if media_type == "video" and video_url:
                    msg = f"{msg}\n\n🎬 Видео: {video_url}" if msg else video_url
                try:
                    chat_id_int = int(max_chat)
                except (TypeError, ValueError):
                    chat_id_int = None
                if chat_id_int is not None:
                    res = await max_send(chat_id_int, msg, token=max_token, buttons=max_buttons,
                                         recipient_kind="chat", parse_mode="html",
                                         attachments=[attach] if attach else None)
                    await _log_chat_send(conn, schedule["id"], "event", "max", max_chat, bool(res))
                    if res:
                        sent += 1
                    if sent_max is not None:
                        sent_max.add(str(max_chat))
        except Exception as ex:
            logger.warning(f"Отправка в MAX-чат события {event_id} упала: {ex}")

    # ── VK-беседа ──
    # VK chat_id события хранится как ПОЛНЫЙ peer_id беседы (2000000000+local).
    vk_chat = (ev["vk_chat_id"] or "").strip() if ev["vk_chat_id"] else ""
    if vk_chat:
        try:
            import random as _random
            from app.services.vk_api import vk_call, upload_photo_to_messages
            from app.services.message_builder import html_to_vk_text
            vk_row = await conn.fetchrow(
                """SELECT ch.bot_token FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id=$1 AND cc.is_active=TRUE AND ch.platform_slug='vk'
                      AND ch.bot_token IS NOT NULL AND ch.bot_token<>'' LIMIT 1""",
                client_id,
            )
            if vk_row and vk_row["bot_token"]:
                _txt = with_support(text, "vk") if with_support else (text or "")
                vk_text = html_to_vk_text(_txt or "")
                if button_url:
                    vk_text = f"{vk_text}\n\n{button_text or 'Подробнее'}: {button_url}"
                try:
                    peer = int(vk_chat)
                except (TypeError, ValueError):
                    peer = None
                if peer is not None:
                    # Фото в VK-беседу: грузим картинку тем же токеном, которым
                    # шлём (иначе owner_id чужой → VK отклонит) → attachment
                    # photo{owner}_{id}. Без peer_id — как в рабочей рассылке по базе.
                    vk_attachment = None
                    if photo_url and media_type != "video":
                        try:
                            vk_attachment = await upload_photo_to_messages(
                                photo_url, token=vk_row["bot_token"]
                            )
                        except Exception as up_ex:
                            logger.warning(f"VK-чат: загрузка фото не удалась: {up_ex}")
                    params = {
                        "peer_id": peer,
                        "message": vk_text,
                        "random_id": _random.randint(1, 2**31 - 1),
                    }
                    if vk_attachment:
                        params["attachment"] = vk_attachment
                    # Шлём если есть текст ИЛИ вложение (фото без текста — норма).
                    if vk_text or vk_attachment:
                        res = await vk_call("messages.send", params, token=vk_row["bot_token"])
                        await _log_chat_send(conn, schedule["id"], "event", "vk", vk_chat, bool(res))
                        if res:
                            sent += 1
                    if sent_vk is not None:
                        sent_vk.add(str(vk_chat))
        except Exception as ex:
            logger.warning(f"Отправка в VK-чат события {event_id} упала: {ex}")

    return sent


async def _send_broadcast_to_client_chats(
    conn, schedule,
    text: str, photo_url: str | None, button_text: str | None, button_url: str | None,
    buttons: list | None = None,
    video_url: str | None = None, media_type: str | None = None,
    sent_vk: set | None = None, sent_max: set | None = None,
    is_private: bool = False,
    with_support=None,
) -> int:
    """Шлёт рассылку в базу чатов клиента (client_broadcast_chats) для VK и MAX.
    is_private=False — общие чаты (is_private=FALSE); True — личные каналы (is_private=TRUE).
    Telegram-чаты этой базы обрабатываются выше (общий TG-блок с дедупом).
    Дедуп: пропускает chat_id, уже отправленные (sent_vk/sent_max) — общий set на все слои.
    Возвращает число успешно отправленных чатов."""
    client_id = schedule["client_id"]
    rows = await conn.fetch(
        """SELECT platform, chat_id FROM client_broadcast_chats
            WHERE client_id = $1 AND platform IN ('vk','max','whatsapp') AND is_active = TRUE
              AND use_for_broadcasts = TRUE AND is_private = $2""",
        client_id, is_private,
    )
    if not rows:
        return 0
    sent = 0
    # Вид чата для статистики: личный канал клиента vs общий чат клиента.
    _ckind = "client_private" if is_private else "client_common"
    sent_vk = sent_vk if sent_vk is not None else set()
    sent_max = sent_max if sent_max is not None else set()

    # ── MAX-чаты ──
    max_chats = [str(r["chat_id"]).strip() for r in rows if r["platform"] == "max" and r["chat_id"]]
    max_chats = [c for c in max_chats if c and c not in sent_max]
    if max_chats:
        try:
            from app.services.max_api import send_message as max_send, tg_inline_to_max_keyboard, upload_media as max_upload_media
            from app.services.message_builder import html_to_telegram
            from app.config import settings as _settings
            max_token = await conn.fetchval(
                """SELECT ch.bot_token FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id=$1 AND cc.is_active=TRUE AND ch.platform_slug='max'
                      AND ch.is_system=FALSE AND ch.bot_token IS NOT NULL AND ch.bot_token<>''
                    LIMIT 1""",
                client_id,
            ) or _settings.max_system_bot_token
            if max_token:
                max_buttons = None
                if buttons:
                    rows_btn = [[{"text": (b.get("text") or b.get("label") or "Открыть"), "url": b.get("url", "")}] for b in buttons]
                    max_buttons = tg_inline_to_max_keyboard(rows_btn)
                elif button_text and button_url:
                    max_buttons = tg_inline_to_max_keyboard([[{"text": button_text, "url": button_url}]])
                _txt = with_support(text, "max") if with_support else (text or "")
                msg = html_to_telegram(_txt or "")
                if media_type == "video" and video_url:
                    msg = f"{msg}\n\n🎬 Видео: {video_url}" if msg else video_url
                attach = None
                if photo_url and media_type != "video":
                    import tempfile, os as _os
                    async with httpx.AsyncClient(timeout=60.0) as _cli:
                        _img = await _cli.get(photo_url)
                    if _img.status_code == 200 and _img.content:
                        _tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
                        try:
                            _tmp.write(_img.content); _tmp.flush(); _tmp.close()
                            attach = await max_upload_media(_tmp.name, token=max_token, kind="image")
                        finally:
                            try: _os.unlink(_tmp.name)
                            except OSError: pass
                for c in max_chats:
                    try:
                        cid_int = int(c)
                    except (TypeError, ValueError):
                        continue
                    try:
                        res = await max_send(cid_int, msg, token=max_token, buttons=max_buttons,
                                             recipient_kind="chat", parse_mode="html",
                                             attachments=[attach] if attach else None)
                        await _log_chat_send(conn, schedule["id"], _ckind, "max", c, bool(res))
                        if res:
                            sent += 1
                        sent_max.add(c)
                    except Exception as ex:
                        await _log_chat_send(conn, schedule["id"], _ckind, "max", c, False, str(ex))
                        logger.warning(f"Отправка в MAX-чат клиента {c} упала: {ex}")
        except Exception as ex:
            logger.warning(f"MAX-часть чатов клиента упала: {ex}")

    # ── WhatsApp-чаты (через мост, только текст; ссылки/видео/кнопка — в тексте) ──
    wa_chats = [str(r["chat_id"]).strip() for r in rows if r["platform"] == "whatsapp" and r["chat_id"]]
    wa_chats = [c for c in wa_chats if c]
    if wa_chats:
        try:
            from app.services import whatsapp_api as wa
            from app.services.message_builder import html_to_vk_text as _to_plain
            # WhatsApp своей поддержки нет — падаем на TG-контакт.
            _txt = with_support(text, "telegram") if with_support else (text or "")
            wa_text = _to_plain(_txt or "")
            # Фото — отправляем картинкой с подписью. Видео — тяжёлое, ссылкой в тексте.
            wa_media = photo_url if (photo_url and media_type != "video") else None
            if media_type == "video" and video_url:
                wa_text = f"{wa_text}\n\n🎬 Видео: {video_url}" if wa_text else video_url
            if button_url:
                wa_text = f"{wa_text}\n\n{button_text or 'Подробнее'}: {button_url}"
            if wa_text.strip() or wa_media:
                for c in wa_chats:
                    try:
                        res = await wa.send_message(client_id, c, wa_text, media_url=wa_media)
                        await _log_chat_send(conn, schedule["id"], _ckind, "whatsapp", c, bool(res and res.get("ok")))
                        if res and res.get("ok"):
                            sent += 1
                    except Exception as ex:
                        await _log_chat_send(conn, schedule["id"], _ckind, "whatsapp", c, False, str(ex))
                        logger.warning(f"Отправка в WhatsApp-чат клиента {c} упала: {ex}")
        except Exception as ex:
            logger.warning(f"WhatsApp-часть чатов клиента упала: {ex}")

    # ── VK-беседы ──
    vk_chats = [str(r["chat_id"]).strip() for r in rows if r["platform"] == "vk" and r["chat_id"]]
    vk_chats = [c for c in vk_chats if c and c not in sent_vk]
    if vk_chats:
        try:
            import random as _random
            from app.services.vk_api import vk_call, upload_photo_to_messages
            from app.services.message_builder import html_to_vk_text
            vk_row = await conn.fetchrow(
                """SELECT ch.bot_token FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id=$1 AND cc.is_active=TRUE AND ch.platform_slug='vk'
                      AND ch.bot_token IS NOT NULL AND ch.bot_token<>'' LIMIT 1""",
                client_id,
            )
            if vk_row and vk_row["bot_token"]:
                _txt = with_support(text, "vk") if with_support else (text or "")
                vk_text = html_to_vk_text(_txt or "")
                if button_url:
                    vk_text = f"{vk_text}\n\n{button_text or 'Подробнее'}: {button_url}"
                vk_attachment = None
                if photo_url and media_type != "video":
                    try:
                        vk_attachment = await upload_photo_to_messages(photo_url, token=vk_row["bot_token"])
                    except Exception as up_ex:
                        logger.warning(f"VK-чат клиента: загрузка фото не удалась: {up_ex}")
                for c in vk_chats:
                    try:
                        peer = int(c)
                    except (TypeError, ValueError):
                        continue
                    params = {"peer_id": peer, "message": vk_text,
                              "random_id": _random.randint(1, 2**31 - 1)}
                    if vk_attachment:
                        params["attachment"] = vk_attachment
                    if vk_text or vk_attachment:
                        try:
                            res = await vk_call("messages.send", params, token=vk_row["bot_token"])
                            await _log_chat_send(conn, schedule["id"], _ckind, "vk", c, bool(res))
                            if res:
                                sent += 1
                            sent_vk.add(c)
                        except Exception as ex:
                            logger.warning(f"Отправка в VK-чат клиента {c} упала: {ex}")
        except Exception as ex:
            logger.warning(f"VK-часть чатов клиента упала: {ex}")

    return sent


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
            """SELECT pu.id AS pu_id, pu.platform_user_id, pu.contact_id,
                      COALESCE(NULLIF(pu.first_name, ''),
                               (SELECT c.name FROM contacts c WHERE c.id = pu.contact_id),
                               '') AS first_name
                 FROM platform_users pu
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                 JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE c_own.client_id = $1
                  AND pu.platform_slug = 'vk'
                  AND ch.platform_slug = 'vk'
                  AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
            client_id,
        )
    elif event_id and aud_include == "registered_event":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id, pu.contact_id,
                      COALESCE(NULLIF(pu.first_name, ''),
                               (SELECT c.name FROM contacts c WHERE c.id = pu.contact_id),
                               '') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'vk'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1 AND ep.is_registered = TRUE
                  AND ch.platform_slug = 'vk' AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
            event_id,
        )
    elif event_id:
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id, pu.contact_id,
                      COALESCE(NULLIF(pu.first_name, ''),
                               (SELECT c.name FROM contacts c WHERE c.id = pu.contact_id),
                               '') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'vk'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1
                  AND ch.platform_slug = 'vk' AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
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

    # Исключение аудитории (audience_exclude) — кросс-платформенно по contact_id.
    # Раньше игнорировалось → смерженный зарег. контакт получал письмо и в сегменте
    # «исключая зарегистрированных» (дубль в VK/MAX/email).
    _vk_excl = await _excluded_contact_ids(conn, event_id, schedule.get("audience_exclude"))
    if _vk_excl:
        rows = [r for r in rows if r["contact_id"] not in _vk_excl]
        if not rows:
            return 0
    # Фильтр по тегам контакта (миграция 265) — та же семантика, что в TG-ветке.
    _vk_tag_inc = schedule.get("audience_tags_include") or []
    _vk_tag_exc = schedule.get("audience_tags_exclude") or []
    if _vk_tag_inc or _vk_tag_exc:
        _vk_keep = await _tag_filtered_contact_ids(
            conn, client_id, _vk_tag_inc, _vk_tag_exc,
            {r["contact_id"] for r in rows if r["contact_id"] is not None})
        rows = [r for r in rows if r["contact_id"] in _vk_keep]
        if not rows:
            return 0
    # Include-сегменты оплаты (paid_event/unpaid_event): оставляем только нужные.
    _vk_paid_on, _vk_paid_keep = await _paid_filter_contact_ids(conn, event_id, aud_include)
    if _vk_paid_on:
        rows = [r for r in rows if r["contact_id"] in _vk_paid_keep]
        if not rows:
            return 0

    # ── Кнопки в VK ──
    # ⚠️ VK НЕ показывает inline-кнопки open_link с внешними ссылками
    # (pluson.ru / t.me и любой не-vk домен): сообщество должно явно
    # разрешить домен, иначе VK молча отбрасывает кнопку — сообщение
    # уходит БЕЗ неё. Симптом «в TG/MAX кнопка есть, в VK нет».
    # Поэтому внешние URL-кнопки в VK пишем СССЫЛКОЙ В ТЕКСТ (доходит
    # всегда), а inline-клавиатуру с open_link не используем. Callback-кнопки
    # (внутренние, без url) VK показывает нормально — их оставляем в клавиатуре.
    def _is_vk_internal(u: str) -> bool:
        u = (u or "").lower()
        return ("vk.com" in u) or ("vk.me" in u) or ("vk.ru" in u)

    keyboard = None
    link_lines: list[str] = []  # «Текст кнопки: url» — допишем в конец сообщения
    kb_rows: list[list[dict]] = []

    # Собираем список (label, url) из всех источников кнопок
    btn_pairs: list[tuple[str, str]] = []
    if buttons:
        for b in buttons:
            lbl = b.get("text") or b.get("label") or "Открыть"
            url = b.get("url", "")
            if url:
                btn_pairs.append((lbl, url))
    elif button_text and button_url:
        btn_pairs.append((button_text, button_url))

    for lbl, url in btn_pairs:
        if _is_vk_internal(url):
            # внутренняя VK-ссылка — open_link работает, оставляем кнопкой
            kb_rows.append([{"text": lbl, "url": url}])
        else:
            # внешняя ссылка — в текст (VK кнопку всё равно срежет)
            link_lines.append(f"{lbl}: {url}")

    if kb_rows:
        keyboard = tg_inline_to_vk_keyboard(kb_rows)

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
        # ⚠️ {first_name} персонализируется ЗДЕСЬ, у каждого получателя свой.
        # В build_message_content он намеренно не трогается. В TG и email это
        # делалось, а в VK — нет: человеку уходил сырой «{first_name}».
        if "{first_name}" in message_text:
            message_text = _apply_first_name(message_text, r["first_name"])
        # Сквозной contact_id в ссылке эфира — по VK-контакту этого получателя.
        if "?c=__CT__" in message_text:
            _ctv = r.get("contact_id")
            message_text = message_text.replace("?c=__CT__", f"?c={_ctv}" if _ctv else "")
        # Внешние URL-кнопки в VK дописываем ссылкой в текст (см. выше).
        if link_lines:
            suffix = "\n\n" + "\n".join(link_lines)
            message_text = f"{message_text}{suffix}" if message_text else suffix.strip()
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
            """SELECT pu.id AS pu_id, pu.platform_user_id, pu.contact_id,
                      COALESCE(NULLIF(pu.first_name, ''),
                               (SELECT c.name FROM contacts c WHERE c.id = pu.contact_id),
                               '') AS first_name
                 FROM platform_users pu
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                 JOIN contacts c_own ON c_own.id = pu.contact_id
                WHERE c_own.client_id = $1
                  AND pu.platform_slug = 'max'
                  AND ch.platform_slug = 'max'
                  AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
            client_id,
        )
    elif event_id and aud_include == "registered_event":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id, pu.contact_id,
                      COALESCE(NULLIF(pu.first_name, ''),
                               (SELECT c.name FROM contacts c WHERE c.id = pu.contact_id),
                               '') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'max'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1 AND ep.is_registered = TRUE
                  AND ch.platform_slug = 'max' AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
            event_id,
        )
    elif event_id:
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.platform_user_id, pu.contact_id,
                      COALESCE(NULLIF(pu.first_name, ''),
                               (SELECT c.name FROM contacts c WHERE c.id = pu.contact_id),
                               '') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'max'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN client_channels cc ON cc.id = puc.client_channel_id
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE ep.event_id = $1
                  AND ch.platform_slug = 'max' AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
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

    # Исключение аудитории (audience_exclude) — кросс-платформенно по contact_id.
    _max_excl = await _excluded_contact_ids(conn, event_id, schedule.get("audience_exclude"))
    if _max_excl:
        rows = [r for r in rows if r["contact_id"] not in _max_excl]
        if not rows:
            return 0
    # Фильтр по тегам контакта (миграция 265) — та же семантика, что в TG-ветке.
    _max_tag_inc = schedule.get("audience_tags_include") or []
    _max_tag_exc = schedule.get("audience_tags_exclude") or []
    if _max_tag_inc or _max_tag_exc:
        _max_keep = await _tag_filtered_contact_ids(
            conn, client_id, _max_tag_inc, _max_tag_exc,
            {r["contact_id"] for r in rows if r["contact_id"] is not None})
        rows = [r for r in rows if r["contact_id"] in _max_keep]
        if not rows:
            return 0
    _max_paid_on, _max_paid_keep = await _paid_filter_contact_ids(conn, event_id, aud_include)
    if _max_paid_on:
        rows = [r for r in rows if r["contact_id"] in _max_paid_keep]
        if not rows:
            return 0

    max_buttons = None
    if buttons:
        rows_btn = [[{"text": (b.get("text") or b.get("label") or "Открыть"), "url": b.get("url", "")}] for b in buttons]
        max_buttons = tg_inline_to_max_keyboard(rows_btn)
    elif button_text and button_url:
        max_buttons = tg_inline_to_max_keyboard([[{"text": button_text, "url": button_url}]])

    # Фото в MAX: скачиваем R2-картинку → грузим в MAX (двухшаговый upload) →
    # attachment переиспользуется для ВСЕХ получателей (token валиден для всех).
    # Делаем один раз на рассылку. Видео в MAX по-прежнему ссылкой (ниже).
    photo_attachment = None
    if photo_url and media_type != "video":
        try:
            from app.services.max_api import upload_media as max_upload_media
            import tempfile, os as _os
            async with httpx.AsyncClient(timeout=60.0) as _cli:
                _img = await _cli.get(photo_url)
            if _img.status_code == 200 and _img.content:
                _ext = ".jpg"
                low = photo_url.lower()
                for e in (".png", ".jpeg", ".jpg", ".webp"):
                    if e in low:
                        _ext = e
                        break
                _tmp = tempfile.NamedTemporaryFile(suffix=_ext, delete=False)
                try:
                    _tmp.write(_img.content)
                    _tmp.flush()
                    _tmp.close()
                    photo_attachment = await max_upload_media(_tmp.name, token=max_token, kind="image")
                finally:
                    try:
                        _os.unlink(_tmp.name)
                    except OSError:
                        pass
            if not photo_attachment:
                logger.warning(f"MAX broadcast: фото не загрузилось ({photo_url[:80]}) — шлём без фото")
        except Exception as e:
            logger.warning(f"MAX broadcast photo upload error: {e}")
            photo_attachment = None

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
        # ⚠️ {first_name} — персонально каждому (см. пояснение в VK-ветке).
        # В MAX подстановки не было вовсе: уходил сырой «{first_name}».
        if "{first_name}" in message_text:
            message_text = _apply_first_name(message_text, r["first_name"])
        # Сквозной contact_id в ссылке эфира — по MAX-контакту этого получателя.
        if "?c=__CT__" in message_text:
            _ctm = r.get("contact_id")
            message_text = message_text.replace("?c=__CT__", f"?c={_ctm}" if _ctm else "")
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
        max_message_id: str | None = None
        try:
            # Рассылка адресуется по user_id подписчика (platform_users.platform_user_id),
            # а не по id беседы — иначе MAX отвечает chat.not.found и молча не доставляет.
            res = await max_send(max_id_int, message_text, token=max_token, buttons=max_buttons, recipient_kind="user", parse_mode="html", attachments=[photo_attachment] if photo_attachment else None)
            ok = bool(res)
            if not ok:
                err = "MAX send returned None"
            elif isinstance(res, dict):
                # mid нужен для отзыва (DELETE /messages). Путь как в dialogs._max_send.
                mid = ((res.get("message") or {}).get("body") or {}).get("mid")
                if mid:
                    max_message_id = str(mid)
        except Exception as e:
            err = str(e)
            logger.warning(f"MAX send failed for max_id={max_id_int}: {e}")
        # Лог отправки — чтобы MAX-получатели тоже попадали в модалку «Получатели рассылки».
        try:
            await conn.execute(
                """INSERT INTO broadcast_log
                       (schedule_id, platform_user_id, channel_id, status, error, external_message_id, sent_at)
                   VALUES ($1, $2, $3, $4, $5, $6, NOW())""",
                schedule["id"], r["pu_id"], max_channel_id,
                "sent" if ok else "failed", err, max_message_id,
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
    # ⚠️ Гейт email-рассылок — ПО ФИЧЕ `email_broadcasts` (не по глобальному флагу
    # и не по tariff_slug). Нет фичи → email-часть пропускается молча.
    #
    # История: с 2026-07-07 клиентские email-рассылки были отключены глобальным
    # флагом settings.email_broadcasts_enabled — Gmail рейтлимитил весь домен
    # pluson.ru (421-4.7.28), письма застревали в очереди Postfix. С 2026-07-28
    # вместо общего рубильника — фича: выдаётся точечно (сейчас тарифу admin),
    # владелец сам решает, кому включать. Системные письма ПЛЮСОНа (подтверждение
    # почты, сброс пароля, письма ассистенту) идут мимо этой функции — напрямую
    # через EmailSender, они гейтом не затрагиваются.
    from app.services.features import client_has_feature
    if not await client_has_feature(conn, schedule["client_id"], "email_broadcasts"):
        logger.info(
            "Email-рассылки недоступны клиенту %s (нет фичи email_broadcasts) — "
            "пропускаю email-часть", schedule["client_id"],
        )
        return 0

    from app.services.email_body import build_email_body, strip_html
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

    # ⚠️ Свой почтовый домен клиента (миграция 270). Если подключён и проверен —
    # письма уходят от него (noreply@его-домен), а не с *.pluson.ru. Ссылки
    # отписки и трекинга при этом тоже переводим на его домен: ссылка на чужой
    # домен в письме от его бренда выглядит подозрительно и для человека, и для
    # спам-фильтра. Не подключён → всё как раньше.
    from app.services.client_domains import client_mail_domain, client_public_url
    _mail = await client_mail_domain(conn, client_id)
    if _mail:
        channel_dict["email_domain"] = _mail["domain"]
        channel_dict["email_from_local"] = _mail["local"]
        if _mail["from_name"]:
            channel_dict["email_from_name"] = _mail["from_name"]
    public_base = await client_public_url(conn, client_id)

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
                      COALESCE(NULLIF(pu.first_name, ''), c.name, '') AS first_name
                 FROM platform_users pu
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE c.client_id = $1
                  AND pu.platform_slug = 'email'
                  AND pu.email_is_dead = FALSE
                  AND puc.client_channel_id = $2
                  AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
            client_id, channel_dict["client_channel_id"],
        )
    elif event_id and aud_include == "registered_event":
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.contact_id, pu.platform_user_id AS email,
                      COALESCE(NULLIF(pu.first_name, ''), c.name, '') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'email'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE ep.event_id = $1 AND ep.is_registered = TRUE
                  AND pu.email_is_dead = FALSE
                  AND puc.client_channel_id = $2
                  AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
            event_id, channel_dict["client_channel_id"],
        )
    elif event_id:
        rows = await conn.fetch(
            """SELECT pu.id AS pu_id, pu.contact_id, pu.platform_user_id AS email,
                      COALESCE(NULLIF(pu.first_name, ''), c.name, '') AS first_name
                 FROM event_participants ep
                 JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug = 'email'
                 JOIN platform_user_channels puc ON puc.platform_user_id = pu.id
                 JOIN contacts c ON c.id = pu.contact_id
                WHERE ep.event_id = $1
                  AND pu.email_is_dead = FALSE
                  AND puc.client_channel_id = $2
                  AND puc.is_unsubscribed = FALSE
                  -- ЧС (миграция 228)
                  AND NOT EXISTS (
                      SELECT 1 FROM contact_blacklist bl
                      WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
                  )""",
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
                """SELECT DISTINCT pu.contact_id FROM platform_users pu
                     JOIN contacts c_own ON c_own.id = pu.contact_id
                    WHERE c_own.client_id = $1 AND pu.platform_slug = 'telegram'
                      AND pu.platform_user_id = ANY($2::text[])""",
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

    # Исключение аудитории (audience_exclude) — кросс-платформенно по contact_id.
    _em_excl = await _excluded_contact_ids(conn, event_id, schedule.get("audience_exclude"))
    if _em_excl:
        rows = [r for r in rows if r["contact_id"] not in _em_excl]
        if not rows:
            return 0
    # Фильтр по тегам контакта (миграция 265) — та же семантика, что в TG-ветке.
    _em_tag_inc = schedule.get("audience_tags_include") or []
    _em_tag_exc = schedule.get("audience_tags_exclude") or []
    if _em_tag_inc or _em_tag_exc:
        _em_keep = await _tag_filtered_contact_ids(
            conn, client_id, _em_tag_inc, _em_tag_exc,
            {r["contact_id"] for r in rows if r["contact_id"] is not None})
        rows = [r for r in rows if r["contact_id"] in _em_keep]
        if not rows:
            return 0
    _em_paid_on, _em_paid_keep = await _paid_filter_contact_ids(conn, event_id, aud_include)
    if _em_paid_on:
        rows = [r for r in rows if r["contact_id"] in _em_paid_keep]
        if not rows:
            return 0

    # ⚠️ Идемпотентность: не шлём повторно тем, кому письмо этой рассылки уже
    # ушло успешно. Нужно при ПЕРЕЗАПУСКЕ рассылки, которая упала на середине
    # (напр. 2026-07-28: #2363 отправила 623 письма и споткнулась на битом
    # адресе — без этого фильтра повторный запуск задублировал бы их).
    # Зеркало already_sent_set из TG-части выше.
    _em_sent_rows = await conn.fetch(
        """SELECT DISTINCT platform_user_id FROM broadcast_log
            WHERE schedule_id = $1 AND status = 'sent'
              AND platform_user_id IS NOT NULL""",
        schedule["id"],
    )
    _em_sent = {r["platform_user_id"] for r in _em_sent_rows}
    if _em_sent:
        before = len(rows)
        rows = [r for r in rows if r["pu_id"] not in _em_sent]
        logger.info(
            "Email-часть рассылки %s: пропускаем %s уже отправленных получателей",
            schedule["id"], before - len(rows),
        )
        if not rows:
            return 0

    # Готовим текст письма. Subject из шаблона рассылок появится в следующей
    # итерации (поле broadcast_templates.subject — отдельная миграция). Пока
    # тема собирается из первой строки текста, если она короткая.
    raw_text = text or ""

    # Subject:
    # 1) Если задан subject_override (поле «Заголовок» из формы рассылки или
    #    welcome_email_subject события) — используем его.
    # 2) Иначе — «Новое сообщение от {бренд клиента}». НЕ берём первую строку
    #    текста, чтобы тема не превращалась в обрезанный кусок body.
    if subject_override and subject_override.strip():
        subject = strip_html(subject_override).strip()[:200]
    else:
        brand_for_subject = (client_brand_name or "ПЛЮСОН").strip()
        subject = f"Новое сообщение от {brand_for_subject}"

    # ⚠️ Тело письма собирает ОДНА функция — общая с тестовой отправкой
    # (app/services/email_body.py). Раньше здесь жила вторая копия той же
    # логики (кнопки, linkify, ресайз фото, обложка видео): копии разошлись,
    # и клиент проверял в тесте вёрстку, которой в боевой рассылке не было.
    # Новая точка отправки письма — звать build_email_body, а не собирать HTML
    # на месте.
    built = await build_email_body(
        text=raw_text,
        photo_url=photo_url,
        video_url=video_url,
        media_type=media_type,
        button_text=button_text,
        button_url=button_url,
        buttons=buttons,
    )
    html_body = built.html
    body_text = built.text
    built_inline_images = built.inline_images

    # Домен клиента, если подключён (миграция 270) — иначе основной.
    # Пиксель и клик-редирект должны жить на домене отправителя: ссылка,
    # уводящая на посторонний домен, снижает доверие почтовых фильтров.
    frontend_url = (public_base or settings.frontend_url).rstrip("/")
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

        # Персонализация: {first_name}. Нет имени — плейсхолдер убирается,
        # заглушек вроде «друг» не подставляем (см. _apply_first_name).
        first_name_val = r["first_name"]
        msg_text = _apply_first_name(body_text, first_name_val)
        # Сквозной contact_id в ссылке эфира — по контакту email-получателя.
        if "?c=__CT__" in msg_text:
            msg_text = msg_text.replace("?c=__CT__", f"?c={r['contact_id']}" if r.get("contact_id") else "")
        msg_html = _apply_first_name(html_body, first_name_val) if html_body else html_body

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
        # ⚠️ Вложения обязательно передать в send: HTML ссылается на них по
        # Content-ID (<img src="cid:...">), без вложения ссылка будет битой и
        # письмо уйдёт без картинки. Собраны один раз до цикла получателей.
        inline_images_arg = built_inline_images or None

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
                public_base_url=public_base,
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
              AND cc.client_id = (SELECT c3.client_id FROM contacts c3 WHERE c3.id = pu.contact_id)
              AND ch.platform_slug = 'telegram'
              AND puc.is_unsubscribed = FALSE
          )
          OR NOT EXISTS (
            SELECT 1 FROM platform_user_channels puc
            JOIN client_channels cc ON cc.id = puc.client_channel_id
            JOIN channels ch ON ch.id = cc.channel_id
            WHERE puc.platform_user_id = pu.id
              AND cc.client_id = (SELECT c3.client_id FROM contacts c3 WHERE c3.id = pu.contact_id)
              AND ch.platform_slug = 'telegram'
          )
        )
        -- ЧЁРНЫЙ СПИСОК (миграция 228): заблокированные у СВОЕГО клиента
        -- исключаются из аудитории. Подставляется во все ветки ниже.
        AND NOT EXISTS (
            SELECT 1 FROM contact_blacklist bl
            WHERE bl.contact_id = pu.contact_id
                        AND bl.client_id = (SELECT c2.client_id FROM contacts c2 WHERE c2.id = pu.contact_id)
        )
    """

    if aud_include == "all_client":
        rows = await conn.fetch(
            f"SELECT pu.platform_user_id FROM platform_users pu "
            f"JOIN contacts c_own ON c_own.id = pu.contact_id "
            f"WHERE c_own.client_id=$1 AND pu.platform_slug='telegram' AND {SUBSCRIBED_CLAUSE}",
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
    elif aud_include in ("paid_event", "unpaid_event"):
        # Оплата по status (миграция 157): 'paid' — оплатил, 'unpaid' — заказ без оплаты.
        _st = "paid" if aud_include == "paid_event" else "unpaid"
        _paid_cond = ("EXISTS (SELECT 1 FROM event_participant_tariffs ept "
                      f"WHERE ept.participant_id = ep.id AND ept.status = '{_st}')")
        rows = await conn.fetch(
            f"""
            SELECT pu.platform_user_id FROM event_participants ep
            JOIN platform_users pu ON pu.contact_id = ep.contact_id AND pu.platform_slug='telegram'
            WHERE ep.event_id=$1 AND {_paid_cond} AND {SUBSCRIBED_CLAUSE}
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

    # ── Фильтр ПО ТЕГАМ контакта (миграция 265) ───────────────────────────
    # Теги живут на contacts.tags (jsonb-массив). Семантика «любой из»
    # (оператор ?|) — та же, что в фильтре контактов в кабинете.
    # Пустой/NULL список = фильтр не применяется (обратная совместимость).
    tags_inc = schedule.get("audience_tags_include") or []
    tags_exc = schedule.get("audience_tags_exclude") or []
    if tags_inc:
        rows_t = await conn.fetch(
            "SELECT pu.platform_user_id FROM platform_users pu "
            "JOIN contacts ct ON ct.id = pu.contact_id "
            "WHERE ct.client_id=$1 AND pu.platform_slug='telegram' "
            "  AND jsonb_typeof(ct.tags)='array' AND ct.tags ?| $2::text[]",
            client_id, list(tags_inc)
        )
        include_ids &= {r["platform_user_id"] for r in rows_t}
    if tags_exc:
        rows_t = await conn.fetch(
            "SELECT pu.platform_user_id FROM platform_users pu "
            "JOIN contacts ct ON ct.id = pu.contact_id "
            "WHERE ct.client_id=$1 AND pu.platform_slug='telegram' "
            "  AND jsonb_typeof(ct.tags)='array' AND ct.tags ?| $2::text[]",
            client_id, list(tags_exc)
        )
        include_ids -= {r["platform_user_id"] for r in rows_t}

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
    elif aud_exclude in ("paid_event", "unpaid_event"):
        _st = "paid" if aud_exclude == "paid_event" else "unpaid"
        _paid_cond = ("EXISTS (SELECT 1 FROM event_participant_tariffs ept "
                      f"WHERE ept.participant_id = ep.id AND ept.status = '{_st}')")
        ex = await conn.fetch(
            f"SELECT pu.platform_user_id FROM event_participants ep "
            f"JOIN platform_users pu ON pu.contact_id=ep.contact_id AND pu.platform_slug='telegram' "
            f"WHERE ep.event_id=$1 AND {_paid_cond}",
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


async def _tag_filtered_contact_ids(conn, client_id, tags_include, tags_exclude, contact_ids):
    """Отфильтровать contact_id по тегам контакта (миграция 265).

    Возвращает множество contact_id, которые ПРОХОДЯТ фильтр.
    include — оставить только тех, у кого есть ХОТЯ БЫ ОДИН из тегов;
    exclude — выбросить тех, у кого есть ХОТЯ БЫ ОДИН из тегов.
    Пустые списки = фильтр не применяется (обратная совместимость).
    Общая точка для VK/MAX/email — у них аудитория собирается по contact_id,
    а не по platform_user_id (для TG фильтр внутри _build_audience).
    """
    keep = set(contact_ids)
    if not keep:
        return keep
    if tags_include:
        rows = await conn.fetch(
            "SELECT ct.id FROM contacts ct WHERE ct.client_id=$1 AND ct.id = ANY($2::int[]) "
            "  AND jsonb_typeof(ct.tags)='array' AND ct.tags ?| $3::text[]",
            client_id, list(keep), list(tags_include))
        keep &= {r["id"] for r in rows}
    if tags_exclude and keep:
        rows = await conn.fetch(
            "SELECT ct.id FROM contacts ct WHERE ct.client_id=$1 AND ct.id = ANY($2::int[]) "
            "  AND jsonb_typeof(ct.tags)='array' AND ct.tags ?| $3::text[]",
            client_id, list(keep), list(tags_exclude))
        keep -= {r["id"] for r in rows}
    return keep


async def _excluded_contact_ids(conn, event_id, aud_exclude) -> set:
    """contact_id, которых надо ИСКЛЮЧИТЬ из аудитории по audience_exclude.

    Возвращает по contact_id (а не platform_user_id), чтобы исключение работало
    кросс-платформенно для смерженных контактов: если контакт зарегистрирован,
    он исключается на ВСЕХ платформах (VK/MAX/email/TG), а не только там, где
    совпал platform_user_id. Используется в VK/MAX/email-частях рассылки.
    """
    if not event_id or aud_exclude in (None, "", "none"):
        return set()
    # Оплата: event_participant_tariffs.status (миграция 157). 'paid' — оплатил;
    # 'unpaid' — создал заказ, но не оплатил.
    _PAID = ("EXISTS (SELECT 1 FROM event_participant_tariffs ept "
             "WHERE ept.participant_id = ep.id AND ept.status = 'paid')")
    _UNPAID = ("EXISTS (SELECT 1 FROM event_participant_tariffs ept "
               "WHERE ept.participant_id = ep.id AND ept.status = 'unpaid')")
    if aud_exclude == "registered_event":
        cond = "ep.is_registered = TRUE"
    elif aud_exclude == "unregistered_event":
        cond = "ep.is_registered = FALSE"
    elif aud_exclude == "paid_event":
        cond = _PAID
    elif aud_exclude == "unpaid_event":
        # имеют неоплаченный заказ (status='unpaid')
        cond = _UNPAID
    elif aud_exclude == "all_event":
        cond = "TRUE"
    else:
        return set()
    ex = await conn.fetch(
        f"SELECT ep.contact_id FROM event_participants ep WHERE ep.event_id=$1 AND {cond}",
        event_id,
    )
    return {r["contact_id"] for r in ex}


async def _paid_filter_contact_ids(conn, event_id, aud_include) -> "tuple[bool, set]":
    """Для include-сегментов оплаты возвращает (нужен_фильтр, множество contact_id,
    которые НАДО ОСТАВИТЬ). Работает поверх базовой аудитории all_event.
    (False, set()) — фильтр по оплате не нужен."""
    if not event_id or aud_include not in ("paid_event", "unpaid_event"):
        return (False, set())
    if aud_include == "paid_event":
        cond = ("EXISTS (SELECT 1 FROM event_participant_tariffs ept "
                "WHERE ept.participant_id = ep.id AND ept.status = 'paid')")
    else:  # unpaid_event — имеют неоплаченный заказ
        cond = ("EXISTS (SELECT 1 FROM event_participant_tariffs ept "
                "WHERE ept.participant_id = ep.id AND ept.status = 'unpaid')")
    rows = await conn.fetch(
        f"SELECT ep.contact_id FROM event_participants ep WHERE ep.event_id=$1 AND {cond}",
        event_id,
    )
    return (True, {r["contact_id"] for r in rows})


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
               -- ⚠️⚠️ И НЕ УДАЛЯЕМ, ПОКА НА ФАЙЛ ССЫЛАЕТСЯ ХОТЬ ОДНА
               -- НЕОТПРАВЛЕННАЯ РАССЫЛКА.
               --
               -- Копия рассылки берёт ТОТ ЖЕ адрес фото — файл один на обе.
               -- Раньше уборщик смотрел только на ту рассылку, что уже ушла:
               -- исходная отправилась, через сутки файл удалён, а копия в
               -- очереди осталась с мёртвой ссылкой. Человек получал рассылку
               -- без картинки и не понимал, куда она делась.
               AND NOT EXISTS (
                 SELECT 1 FROM broadcast_schedules bs2
                  WHERE (bs2.snapshot_photo = cf.url OR bs2.snapshot_video = cf.url)
                    AND bs2.status NOT IN ('done', 'cancelled', 'paused_subscription_expired')
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
