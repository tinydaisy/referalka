"""
/start handler для @pluson_bot.

Сценарии:
  /start fnl_<run_id>  — landing воронки лид-магнита (см. funnel_service.run_started)
  /start ref_pg<...>   — переход с реф-ссылки события (открываем Mini App)
  /start ref_<old>     — старый формат ref-кода (compat)
  /start               — приветствие + ссылка на свои события
"""
from aiogram import Router, F
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.filters import CommandStart, CommandObject, Command
from app.config import settings
from app.database import get_pool
import html as _html
import logging
from datetime import datetime
from zoneinfo import ZoneInfo
import httpx

router = Router()
log = logging.getLogger(__name__)


async def _record_subscription(message: Message) -> None:
    """Регистрирует подписку пользователя на этот конкретный TG-канал.

    Архитектура G — определяем client_id:
      - Системный канал (@pluson_bot, is_system=TRUE) → системный клиент «ПЛЮСОН Сервис».
      - VIP-канал клиента → client_id из client_channels.

    Если потом пользователь сделает /start с реф/событием — запись в контексте того
    клиента создастся отдельно (через ref-handler / event_start). Это не баг, а фича:
    один tg_id может быть в нескольких контекстах одновременно.
    """
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return
    try:
        from app.services.channels import find_channel_by_bot_id, register_telegram_subscription
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                return
            # Определяем client_id для записи подписки
            if ch["is_system"]:
                client_id = await db.fetchval(
                    "SELECT id FROM clients WHERE email='system@pluson.ru' AND is_active=TRUE LIMIT 1"
                )
            else:
                client_id = await db.fetchval(
                    """SELECT client_id FROM client_channels
                        WHERE channel_id = $1 ORDER BY is_active DESC, id ASC LIMIT 1""",
                    ch["id"]
                )
            if not client_id:
                return
            await register_telegram_subscription(
                client_id, ch["id"], str(user.id),
                username=user.username or "",
                first_name=user.first_name or "",
                last_name=user.last_name or "",
                db=db,
            )
    except Exception as e:
        log.warning("record_subscription failed: %s", e)


@router.message(CommandStart())
async def handle_start(message: Message, command: CommandObject):
    args = (command.args or "").strip()
    user = message.from_user

    # Регистрируем подписку — для счётчика подписчиков канала и базы контактов
    await _record_subscription(message)

    # Воронка лид-магнита
    if args.startswith("fnl_"):
        try:
            run_id = int(args.removeprefix("fnl_"))
        except ValueError:
            run_id = None
        if run_id:
            pool = await get_pool()
            from app.services.funnel_service import run_started
            try:
                bot_id = message.bot.id if message.bot else None
                async with pool.acquire() as db:
                    await run_started(
                        run_id,
                        str(user.id),
                        user.username or "",
                        user.first_name or "",
                        user.last_name or "",
                        db,
                        bot_id=bot_id,
                    )
                return
            except Exception as e:
                log.exception("run_started failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

    # /start reg_<event_slug> — пользователь только что оплатил на стороннем
    # лендинге и был отправлен в бота через t.me-ссылку (страница /r/{slug}
    # в браузере без Telegram.WebApp → universal link → этот бот).
    # Дозарегистрируем участника по tg_id и пришлём приветствие + Mini App.
    if args.startswith("reg_"):
        event_slug = args.removeprefix("reg_").strip()
        if event_slug:
            try:
                pool = await get_pool()
                async with pool.acquire() as db:
                    from app.services.contact_merge import upsert_contact_with_identity
                    event = await db.fetchrow(
                        "SELECT id, client_id, title, slug FROM events WHERE slug=$1 AND status='published'",
                        event_slug,
                    )
                    if event:
                        contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                            db,
                            client_id=event["client_id"],
                            platform_slug='telegram',
                            platform_user_id=str(user.id),
                            username=user.username or "",
                            first_name=user.first_name or "",
                            last_name=user.last_name or "",
                        )
                        existing = await db.fetchval(
                            "SELECT id FROM event_participants WHERE event_id=$1 AND contact_id=$2",
                            event["id"], contact_id,
                        )
                        if existing:
                            await db.execute(
                                "UPDATE event_participants SET is_registered=TRUE WHERE id=$1",
                                existing,
                            )
                        else:
                            await db.execute(
                                """INSERT INTO event_participants (event_id, contact_id, is_registered)
                                   VALUES ($1, $2, TRUE)""",
                                event["id"], contact_id,
                            )
                        # Mini App открывается прямо в контексте этого события.
                        # Для VIP-бота клиента — /c/{client_id}/tg/event/{slug},
                        # для общего @pluson_bot — /tg/event/{slug}.
                        # Бот VIP — это бот, у которого `is_system=FALSE` среди
                        # активных каналов клиента.
                        is_vip_bot = await db.fetchval(
                            """SELECT COALESCE(BOOL_OR(NOT ch.is_system), FALSE)
                                 FROM channels ch
                                 JOIN client_channels cc ON cc.channel_id = ch.id
                                WHERE cc.client_id = $1
                                  AND ch.platform_slug = 'telegram'
                                  AND cc.is_active = TRUE
                                  AND ch.bot_token IS NOT NULL AND ch.bot_token <> ''""",
                            event["client_id"],
                        )
                        base = "https://pluson.ru"
                        path = f"/c/{event['client_id']}/tg/event/{event_slug}" if is_vip_bot else f"/tg/event/{event_slug}"
                        mini_app_url = f"{base}{path}?_reg=1"
                        kb = InlineKeyboardMarkup(inline_keyboard=[[
                            InlineKeyboardButton(text="🎉 Открыть кабинет события",
                                                 web_app=WebAppInfo(url=mini_app_url))
                        ]])
                        await message.answer(
                            f"Поздравляем с регистрацией на «{event['title']}»! 🎉\n\n"
                            f"Откройте кабинет события, чтобы попасть в чат участников и забрать партнёрскую ссылку.",
                            reply_markup=kb,
                        )
                        return
            except Exception as e:
                log.exception("reg_ handler failed: %s", e)

    # Старый сценарий: реф-ссылка события → Mini App
    if args.startswith("ref_") or args.startswith("ref"):
        mini_app_url = f"{settings.mini_app_url}?ref={args}"
        keyboard = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(
                text="🎮 Открыть",
                web_app=WebAppInfo(url=mini_app_url)
            )
        ]])
        await message.answer(
            f"Привет, {user.first_name or ''}! 👋\n\nНажмите кнопку, чтобы открыть приложение.",
            reply_markup=keyboard,
        )
        return

    # Прямой /start
    await message.answer(
        f"Привет, {user.first_name or ''}! 👋\n\n"
        f"Я бот <b>ПЛЮСОН</b> — платформы событийного и реферального маркетинга.\n\n"
        f"Откройте Mini App или перейдите по ссылке организатора.",
        parse_mode="HTML",
    )


@router.message(Command(commands=["getchatid"]))
async def handle_getchatid(message: Message):
    """Подсказка для клиента: как получить chat_id канала уведомлений.
    Если бот добавлен админом в канал и клиент пересылает сюда сообщение из канала —
    бот отвечает chat_id канала (forward_from_chat.id)."""
    fwd = message.forward_from_chat
    if fwd:
        await message.answer(
            f"<b>ID канала:</b> <code>{fwd.id}</code>\n\n"
            f"Скопируйте это число и вставьте в поле «Канал уведомлений» в Настройках → Технические.",
            parse_mode="HTML",
        )
        return
    await message.answer(
        "Чтобы узнать ID канала:\n\n"
        "1. Создайте Telegram-канал (или используйте существующий).\n"
        "2. Добавьте меня (@pluson_bot) в этот канал админом — права не нужны.\n"
        "3. Перешлите мне сюда любое сообщение из канала.\n\n"
        "Я отвечу с ID канала, который надо вставить в Настройки → Технические.",
    )


@router.message(
    F.chat.type == 'private'
    & F.text
    & ~F.text.startswith('/')
    & F.forward_from_chat.is_(None)
    & F.forward_from.is_(None)
)
async def handle_user_message(message: Message):
    """Свободное сообщение пользователя в бот клиента (VIP или системный @pluson_bot).

    Что делаем:
      1. Определяем клиента-получателя:
         - VIP-бот (is_system=FALSE) → единственный главный клиент из client_channels.
         - Системный @pluson_bot → самый свежий не-системный контекст этого tg_id
           (последний `platform_users.updated_at`).
      2. Шлём в `clients.notifications_telegram_chat_id` сообщение с хештегом
         #user_message и всеми стандартными полями (никнейм, имя, контакт-id, TG ID,
         utm_source, ссылка на карточку) + полный текст.
      3. Отвечаем пользователю:
         - если у него есть @username → «передадим, но для скорости продублируйте
           сами @work_tg»
         - если нет → «у вас не указан Telegram-никнейм, мы не сможем вам ответить —
           напишите напрямую @work_tg»
    """
    user = message.from_user
    bot_id = message.bot.id if message.bot else None
    if not user or not bot_id:
        return
    try:
        from app.services.channels import find_channel_by_bot_id
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                return

            # 1. Кому пересылаем?
            if ch["is_system"]:
                client_id = await db.fetchval(
                    """SELECT pu.client_id
                         FROM platform_users pu
                         JOIN clients c ON c.id = pu.client_id
                        WHERE pu.platform_slug = 'telegram'
                          AND pu.platform_user_id = $1
                          AND c.email <> 'system@pluson.ru'
                        ORDER BY pu.updated_at DESC NULLS LAST, pu.id DESC
                        LIMIT 1""",
                    str(user.id),
                )
            else:
                client_id = await db.fetchval(
                    """SELECT client_id FROM client_channels
                        WHERE channel_id = $1
                        ORDER BY is_active DESC, id ASC LIMIT 1""",
                    ch["id"],
                )
            if not client_id:
                # Контекст клиента неизвестен — молча выходим, чтобы пользователь
                # не получил «техническую» ошибку. Сообщение нигде не оседает —
                # это сознательный компромисс v1.
                return

            # 2. Реквизиты клиента
            client_row = await db.fetchrow(
                """SELECT notifications_telegram_chat_id, work_tg_username
                     FROM clients WHERE id = $1""",
                client_id,
            )
            if not client_row:
                return
            notif_chat_id = client_row["notifications_telegram_chat_id"]
            work_tg = (client_row["work_tg_username"] or "").lstrip("@")

            # 3. Контакт юзера в контексте этого клиента
            contact_row = await db.fetchrow(
                """SELECT pu.contact_id, c.name, c.utm_source
                     FROM platform_users pu
                LEFT JOIN contacts c ON c.id = pu.contact_id
                    WHERE pu.client_id = $1
                      AND pu.platform_slug = 'telegram'
                      AND pu.platform_user_id = $2""",
                client_id, str(user.id),
            )
            contact_id = contact_row["contact_id"] if contact_row else None
            contact_name = (contact_row["name"] if contact_row else "") or ""
            utm_source = (contact_row["utm_source"] if contact_row else None)

            # 4. Хендл бота — для контекста в уведомлении
            bot_handle = await db.fetchval(
                "SELECT handle FROM channels WHERE id = $1", ch["id"],
            )

        # 5. Уведомление в канал клиента (от @pluson_bot — как и остальные уведомления)
        if notif_chat_id:
            when_str = datetime.now(ZoneInfo("Europe/Moscow")).strftime("%d.%m.%Y %H:%M")
            display_name = (
                ((user.first_name or "") + " " + (user.last_name or "")).strip()
                or contact_name or "—"
            )
            user_nick = f"@{user.username}" if user.username else "—"
            card_url = (
                f"{settings.frontend_url}/dashboard/clients?contact={contact_id}"
                if contact_id else "—"
            )
            parts = [
                "#user_message 💬",
                "",
                f"<b>Когда:</b> {when_str}",
                f"<b>Бот:</b> {bot_handle or '—'}",
                "",
                "<b>Кто написал</b>",
                f"<b>Никнейм:</b> {user_nick}",
                f"<b>Имя:</b> {_html.escape(display_name)}",
                f"<b>TG ID:</b> <code>{user.id}</code>",
                f"<b>ID контакта:</b> {('#' + str(contact_id)) if contact_id else '—'}",
                f"<b>Источник (utm_source):</b> {_html.escape(utm_source) if utm_source else '—'}",
                f"<b>Карточка:</b> {card_url}",
                "",
                "<b>Сообщение:</b>",
                _html.escape(message.text or ""),
            ]
            text = "\n".join(parts)
            token = settings.telegram_bot_token
            if token:
                try:
                    async with httpx.AsyncClient(timeout=10) as http:
                        await http.post(
                            f"https://api.telegram.org/bot{token}/sendMessage",
                            json={
                                "chat_id": notif_chat_id,
                                "text": text,
                                "parse_mode": "HTML",
                                "disable_web_page_preview": True,
                            },
                        )
                except Exception as e:
                    log.warning("user_message notify failed: %s", e)

        # 6. Ответ пользователю
        if user.username and work_tg:
            reply = (
                "Спасибо, мы передали ваше сообщение службе заботы 💛\n\n"
                f"Для скорости — продублируйте, пожалуйста, своё сообщение сами "
                f"в Telegram: @{work_tg}"
            )
        elif user.username and not work_tg:
            reply = "Спасибо, мы передали ваше сообщение — ответим здесь, в этом боте."
        elif not user.username and work_tg:
            reply = (
                "У вас не указан Telegram-никнейм — мы не сможем вам ответить сюда.\n\n"
                f"Пожалуйста, напишите напрямую в Telegram: @{work_tg}"
            )
        else:
            reply = (
                "У вас не указан Telegram-никнейм — мы не сможем вам ответить сюда. "
                "Добавьте никнейм в настройках Telegram и напишите снова."
            )
        await message.answer(reply)
    except Exception as e:
        log.exception("handle_user_message failed: %s", e)


@router.message(F.chat.type == 'private')
async def handle_forwarded(message: Message):
    """Любая пересланная сюда из канала запись — отвечаем chat_id (для /getchatid).

    Только в личке с ботом. В групповых чатах/каналах Telegram сам форвардит
    посты канала в привязанный чат, и без этого фильтра бот сыпал ответами
    «ID канала: …» в чат, что не нужно.
    """
    fwd = message.forward_from_chat
    if fwd:
        await message.answer(
            f"<b>ID канала:</b> <code>{fwd.id}</code>",
            parse_mode="HTML",
        )
