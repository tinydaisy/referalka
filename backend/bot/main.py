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
from aiogram.exceptions import TelegramUnauthorizedError
from bot.handlers import start, funnel, chat_member, chat_gate, chat_listener, medialift_flow, tech_reply
from app.config import settings
from app.database import get_pool

logger = logging.getLogger(__name__)


async def _make_bot(token: str, label: str, *, retries: int = 3) -> Bot | None:
    """Создать бот и проверить токен через getMe.

    ⚠️ getMe — сетевой вызов к api.telegram.org. Разовый таймаут при старте
    раньше НАВСЕГДА выкидывал бот из поллинга (до следующего рестарта) — так
    бот VIP-клиента переставал отвечать на /start из-за секундного сбоя сети.
    Поэтому ретраим несколько раз с нарастающей паузой; бот отсеивается только
    если токен реально невалиден (повторный 401) или сеть не поднялась за все
    попытки.
    """
    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            me = await bot.get_me()
            logger.info("Bot %s (@%s) ready", label, me.username)
            return bot
        except TelegramUnauthorizedError as e:
            # Токен невалиден — ретраить бессмысленно.
            logger.warning("Bot %s — токен невалиден (%s), пропускаем", label, e)
            break
        except Exception as e:  # noqa: BLE001 — сетевые/таймаут → ретраим
            last_err = e
            logger.warning("Bot %s — getMe попытка %d/%d не удалась (%s)",
                           label, attempt, retries, e)
            if attempt < retries:
                await asyncio.sleep(2 * attempt)  # 2с, 4с, …
    else:
        logger.error("Bot %s — getMe не прошёл за %d попыток (%s), пропускаем",
                     label, retries, last_err)
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

    # VIP-боты клиентов — грузим ПАРАЛЛЕЛЬНО.
    # ⚠️ Свежесозданный бот Telegram первые минуты иногда отвечает на getMe с
    # большой задержкой/таймаутом (прогрев на стороне Telegram). При
    # последовательной загрузке один зависший getMe блокировал старт ВСЕХ
    # последующих ботов и затягивал запуск. asyncio.gather делает каждый getMe
    # независимым — зависший бот не мешает остальным, а ретраи в _make_bot
    # дают ему дополнительные попытки.
    vip: list[tuple[str, str]] = []
    for label, token in await _load_vip_tokens():
        if token in seen_tokens:
            continue
        seen_tokens.add(token)
        vip.append((label, token))
    if vip:
        results = await asyncio.gather(
            *[_make_bot(token, label) for label, token in vip],
            return_exceptions=True,
        )
        for r in results:
            if isinstance(r, Bot):
                bots.append(r)
            elif isinstance(r, Exception):
                logger.warning("VIP-бот не запущен (исключение): %s", r)

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
    # МедиаЛифт — воронка автоподписки в боте (callback'и ml_* + ссылка на канал).
    # ПЕРЕД start.router: иначе его текстовый хендлер перехватит ссылку канала.
    dp.include_router(medialift_flow.router)
    # ⚠️ ПЕРЕД start.router: менеджер отвечает клиенту РЕПЛАЕМ на уведомление,
    # а у start есть общий текстовый хендлер — он перехватил бы реплай раньше.
    dp.include_router(tech_reply.router)
    dp.include_router(start.router)
    # Слушалка чатов событий — ПОСЛЕДНЯЯ. Ловит групповые сообщения чатов
    # событий и складывает в архив (для подсчёта заданий). Отдельно от логики
    # ботов: ничего не отвечает людям, только архивирует. Идёт после start,
    # чтобы /start и команды бота отработали раньше.
    dp.include_router(chat_listener.router)

    logger.info("Запущено %d бот(ов) в polling-режиме", len(bots))
    try:
        await dp.start_polling(
            *bots,
            skip_updates=True,
            # my_chat_member — блок/разблок бота юзером (is_unsubscribed).
            # chat_member — вход/выход ЛЮБОГО участника в группах: ловим, чтобы
            # авто-метить event_participants.is_in_chat для Telegram-чата события
            # (бот ОБЯЗАН быть админом, иначе Telegram эти апдейты не шлёт).
            allowed_updates=["message", "callback_query", "my_chat_member", "chat_member"],
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
