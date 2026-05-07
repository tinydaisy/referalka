"""
/start handler для @pluson_bot.

Сценарии:
  /start fnl_<run_id>  — landing воронки лид-магнита (см. funnel_service.run_started)
  /start ref_pg<...>   — переход с реф-ссылки события (открываем Mini App)
  /start ref_<old>     — старый формат ref-кода (compat)
  /start               — приветствие + ссылка на свои события
"""
from aiogram import Router
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.filters import CommandStart, CommandObject, Command
from app.config import settings
from app.database import get_pool
import logging

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


@router.message()
async def handle_forwarded(message: Message):
    """Любая пересланная сюда из канала запись — отвечаем chat_id (для /getchatid)."""
    fwd = message.forward_from_chat
    if fwd:
        await message.answer(
            f"<b>ID канала:</b> <code>{fwd.id}</code>",
            parse_mode="HTML",
        )
