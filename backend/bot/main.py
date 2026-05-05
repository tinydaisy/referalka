"""
Точка входа Telegram бота PLUSSON.
Режим: Polling (на dev/prod через systemd).

Бот @pluson_bot обрабатывает:
- /start с deep-link payload (fnl_<run_id> для воронок, ref_pg<...> для рефералки)
- /getchatid и пересылку сообщений из канала (для настройки канала уведомлений)
- callback "Готово" в воронке лид-магнита
"""
import asyncio
import logging
from aiogram import Bot, Dispatcher
from aiogram.enums import ParseMode
from aiogram.client.default import DefaultBotProperties
from bot.handlers import start, funnel
from app.config import settings

logger = logging.getLogger(__name__)


async def main():
    if not settings.telegram_bot_token:
        logger.warning("TELEGRAM_BOT_TOKEN не задан — бот не запустится")
        return

    bot = Bot(
        token=settings.telegram_bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML)
    )
    dp = Dispatcher()
    # Порядок важен: callback-handler funnel — первым, потом start (последний message handler — общий fallback).
    dp.include_router(funnel.router)
    dp.include_router(start.router)

    logger.info("Бот ПЛЮСОН запускается (polling)...")
    await dp.start_polling(bot, skip_updates=True, allowed_updates=["message", "callback_query"])


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s — %(name)s — %(levelname)s — %(message)s"
    )
    asyncio.run(main())
