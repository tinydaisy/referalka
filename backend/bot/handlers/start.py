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


@router.message(CommandStart())
async def handle_start(message: Message, command: CommandObject):
    args = (command.args or "").strip()
    user = message.from_user

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
                async with pool.acquire() as db:
                    await run_started(
                        run_id,
                        str(user.id),
                        user.username or "",
                        user.first_name or "",
                        user.last_name or "",
                        db,
                    )
                return
            except Exception as e:
                log.exception("run_started failed: %s", e)
                await message.answer("Что-то пошло не так. Попробуйте ещё раз позже.")
                return

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
        f"Я бот сервиса <b>ПЛЮСОН</b> — реферальной платформы.\n\n"
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
