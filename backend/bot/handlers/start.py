"""
Обработчик /start для Telegram бота PLUSSON.

Сценарии:
1. /start ref_XXXXXXXX — участник пришёл по реферальной ссылке
2. /start — прямой вход без кода (информационное сообщение)
"""
from aiogram import Router, F
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.filters import CommandStart, CommandObject
from app.config import settings

router = Router()


@router.message(CommandStart())
async def handle_start(message: Message, command: CommandObject):
    args = command.args
    user = message.from_user

    if args:
        # Участник пришёл по реферальной ссылке
        ref_code = args.strip()

        # Формируем URL Mini App с ref_code
        mini_app_url = f"{settings.mini_app_url}?ref={ref_code}"

        keyboard = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(
                text="🎮 Открыть реферальную игру",
                web_app=WebAppInfo(url=mini_app_url)
            )
        ]])

        await message.answer(
            f"Привет, {user.first_name}! 👋\n\n"
            f"Вы перешли по реферальной ссылке. Нажмите кнопку ниже, "
            f"чтобы открыть свой кабинет и получить личную реферальную ссылку.\n\n"
            f"За каждого приглашённого друга вы получите подарок 🎁",
            reply_markup=keyboard
        )

        # TODO: вызвать participant_service для регистрации в событии
        # await register_participant(event_slug, user.id, user.username, ref_code, db)

    else:
        # Прямой /start без реферального кода
        await message.answer(
            f"Привет, {user.first_name}! 👋\n\n"
            f"Я бот сервиса <b>ПЛЮСОН</b> — реферальной платформы.\n\n"
            f"Чтобы участвовать в реферальной игре, перейдите по ссылке вашего организатора события.",
            parse_mode="HTML"
        )
