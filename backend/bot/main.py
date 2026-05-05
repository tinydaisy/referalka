"""
Точка входа Telegram-ботов PLUSSON.

Запускает polling параллельно для:
  - Основного @pluson_bot (settings.telegram_bot_token)
  - Всех VIP-ботов клиентов с allow_custom_bot=TRUE (channels.bot_token)

Все боты используют одни и те же handlers (start, funnel) — они умеют резолвить
client_id по run_id из funnel_runs, поэтому общий код подходит и общему боту,
и боту клиента.
"""
import asyncio
import logging
from aiogram import Bot, Dispatcher
from aiogram.enums import ParseMode
from aiogram.client.default import DefaultBotProperties
from bot.handlers import start, funnel
from app.config import settings
from app.database import get_pool

logger = logging.getLogger(__name__)


def _build_dispatcher() -> Dispatcher:
    dp = Dispatcher()
    # Порядок важен: callback handler funnel сначала, потом message handler start.
    dp.include_router(funnel.router)
    dp.include_router(start.router)
    return dp


async def _run_one(token: str, label: str) -> None:
    if not token:
        return
    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = _build_dispatcher()
    try:
        me = await bot.get_me()
        logger.info("Bot %s (@%s) — polling started", label, me.username)
    except Exception as e:
        logger.warning("Bot %s — getMe failed (%s), пропускаем", label, e)
        await bot.session.close()
        return
    try:
        await dp.start_polling(bot, skip_updates=True, allowed_updates=["message", "callback_query"])
    except Exception as e:
        logger.exception("Bot %s polling crashed: %s", label, e)
    finally:
        await bot.session.close()


async def _load_vip_tokens() -> list[tuple[str, str]]:
    """Все активные TG-боты VIP-клиентов из channels."""
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            rows = await db.fetch(
                """SELECT ch.handle, ch.bot_token
                     FROM channels ch
                     JOIN clients c ON c.id = ch.client_id
                     JOIN tariffs t ON t.slug = c.tariff_slug
                    WHERE ch.platform_slug = 'telegram'
                      AND ch.is_active = TRUE
                      AND ch.bot_token IS NOT NULL
                      AND ch.bot_token <> ''
                      AND COALESCE(t.allow_custom_bot, FALSE) = TRUE"""
            )
        return [(r["handle"] or "vip", r["bot_token"]) for r in rows]
    except Exception as e:
        logger.warning("Не получилось загрузить VIP-боты: %s", e)
        return []


async def main() -> None:
    tasks: list[asyncio.Task] = []
    seen_tokens: set[str] = set()

    # Основной @pluson_bot
    if settings.telegram_bot_token:
        seen_tokens.add(settings.telegram_bot_token)
        tasks.append(asyncio.create_task(_run_one(settings.telegram_bot_token, "pluson_bot")))
    else:
        logger.warning("TELEGRAM_BOT_TOKEN не задан — основной бот не запустится")

    # VIP-боты клиентов
    for label, token in await _load_vip_tokens():
        if token in seen_tokens:
            continue
        seen_tokens.add(token)
        tasks.append(asyncio.create_task(_run_one(token, label)))

    if not tasks:
        logger.error("Нет ни одного бота для запуска — выходим")
        return

    logger.info("Запущено %d бот(ов) в polling-режиме", len(tasks))
    # Ждём все задачи; если один упадёт — остальные продолжают работать
    await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s — %(name)s — %(levelname)s — %(message)s"
    )
    asyncio.run(main())
