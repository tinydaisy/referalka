"""
Точка входа Telegram-ботов PLUSSON.

Polling для:
  - Основного @pluson_bot (settings.telegram_bot_token)
  - Ботов клиентов с активной фичей 'channels' (channels.bot_token, client_channels.is_active=TRUE).
    Если подписка истекла или клиент понизил тариф — бот выпадает из polling, входящие /start
    перестают обрабатываться.

Все боты используют один общий Dispatcher с одним и тем же набором handlers
(start, funnel) — aiogram 3 умеет polling нескольких Bot-объектов в одном
dispatcher через `dp.start_polling(*bots, ...)`. Резолв клиента по run_id из
funnel_runs идёт внутри handlers.
"""
import asyncio
import logging
from aiogram import Bot, Dispatcher
from aiogram.enums import ParseMode
from aiogram.client.default import DefaultBotProperties
from bot.handlers import start, funnel, chat_member, chat_gate
from app.config import settings
from app.database import get_pool

logger = logging.getLogger(__name__)


async def _make_bot(token: str, label: str) -> Bot | None:
    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    try:
        me = await bot.get_me()
        logger.info("Bot %s (@%s) ready", label, me.username)
        return bot
    except Exception as e:
        logger.warning("Bot %s — getMe failed (%s), пропускаем", label, e)
        try:
            await bot.session.close()
        except Exception:
            pass
        return None


async def _load_vip_tokens() -> list[tuple[str, str]]:
    """Все активные TG-боты VIP-клиентов из channels.

    Архитектура G: канал привязан к клиенту через client_channels.
    Берём только не-системные каналы (is_system=FALSE) — системные (@pluson_bot) уже
    обслуживаются основным settings.telegram_bot_token.
    """
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            rows = await db.fetch(
                """SELECT DISTINCT ch.handle, ch.bot_token
                     FROM channels ch
                     JOIN client_channels cc ON cc.channel_id = ch.id
                     JOIN clients c ON c.id = cc.client_id
                    WHERE ch.platform_slug = 'telegram'
                      AND ch.is_system = FALSE
                      AND cc.is_active = TRUE
                      AND ch.bot_token IS NOT NULL
                      AND ch.bot_token <> ''
                      -- Polling крутим только для клиентов с активной фичей 'channels'.
                      -- При истечении подписки или понижении тарифа бот перестаёт слушать.
                      AND EXISTS (
                        SELECT 1 FROM client_subscriptions cs
                          JOIN tariff_features tf ON tf.tariff_id = cs.tariff_id
                          JOIN features f         ON f.id = tf.feature_id
                         WHERE cs.client_id = c.id
                           AND f.slug = 'channels'
                           AND cs.status = 'active'
                           AND cs.expires_at > NOW()
                      )"""
            )
        return [(r["handle"] or "vip", r["bot_token"]) for r in rows]
    except Exception as e:
        logger.warning("Не получилось загрузить VIP-боты: %s", e)
        return []


async def main() -> None:
    bots: list[Bot] = []
    seen_tokens: set[str] = set()

    # Основной @pluson_bot
    if settings.telegram_bot_token:
        seen_tokens.add(settings.telegram_bot_token)
        b = await _make_bot(settings.telegram_bot_token, "pluson_bot")
        if b:
            bots.append(b)
    else:
        logger.warning("TELEGRAM_BOT_TOKEN не задан — основной бот не запустится")

    # VIP-боты клиентов
    for label, token in await _load_vip_tokens():
        if token in seen_tokens:
            continue
        seen_tokens.add(token)
        b = await _make_bot(token, label)
        if b:
            bots.append(b)

    if not bots:
        logger.error("Нет ни одного бота для запуска — выходим")
        return

    # Один Dispatcher на все боты — aiogram 3 поддерживает мульти-бот polling
    dp = Dispatcher()
    dp.include_router(funnel.router)
    dp.include_router(chat_member.router)
    # chat_gate должен быть ПЕРЕД start.router: в групповых сообщениях
    # /start <param> может попадать в start handler если он зарегистрирован раньше,
    # а нам нужно сначала проверить подписку и при необходимости удалить.
    dp.include_router(chat_gate.router)
    dp.include_router(start.router)

    logger.info("Запущено %d бот(ов) в polling-режиме", len(bots))
    try:
        await dp.start_polling(
            *bots,
            skip_updates=True,
            # my_chat_member нужен чтобы ловить блок/разблок бота юзером
            # (для отметки is_unsubscribed в platform_user_channels)
            allowed_updates=["message", "callback_query", "my_chat_member"],
        )
    finally:
        for b in bots:
            try:
                await b.session.close()
            except Exception:
                pass


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s — %(name)s — %(levelname)s — %(message)s"
    )
    asyncio.run(main())
