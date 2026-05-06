"""my_chat_member handler — ловит блокировку/разблокировку бота пользователем.

Telegram шлёт `my_chat_member` каждый раз когда статус бота в чате меняется:
- член → kicked  (юзер заблокировал бот) → помечаем is_unsubscribed=TRUE
- kicked → member (юзер разблокировал) → возвращаем is_unsubscribed=FALSE

Это критично для аналитики каналов и для рассылок — иначе мы будем слать сообщения
заблокированным юзерам и получать 403 Forbidden от Telegram.
"""
import logging
from aiogram import Router
from aiogram.types import ChatMemberUpdated
from app.database import get_pool
from app.services.channels import (
    find_channel_by_bot_id,
    mark_unsubscribed_by_tg_id,
    register_telegram_subscription,
)

router = Router()
log = logging.getLogger(__name__)


@router.my_chat_member()
async def handle_my_chat_member(update: ChatMemberUpdated):
    """Реагируем только на приватные чаты (`type='private'`) — это пользователи.
    Группы/каналы где бот добавлен админом — пропускаем (не наша зона)."""
    if update.chat.type != "private":
        return
    new_status = update.new_chat_member.status if update.new_chat_member else None
    user = update.from_user
    bot = update.bot
    if not new_status or not user or not bot:
        return

    tg_id = str(user.id)
    bot_id = bot.id

    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            ch = await find_channel_by_bot_id(bot_id, db)
            if not ch:
                log.warning("my_chat_member: канал для bot_id=%s не найден", bot_id)
                return

            if new_status in ("kicked", "left"):
                # Юзер заблокировал/удалил бота
                await mark_unsubscribed_by_tg_id(
                    ch["client_id"], tg_id, db, channel_id=ch["id"]
                )
                log.info("subscription: %s заблокировал bot=%s ch=%s", tg_id, bot_id, ch["id"])
            elif new_status == "member":
                # Юзер разблокировал — возвращаем подписку
                await register_telegram_subscription(
                    ch["client_id"], ch["id"], tg_id,
                    username=user.username or "",
                    first_name=user.first_name or "",
                    last_name=user.last_name or "",
                    db=db,
                )
                log.info("subscription: %s разблокировал bot=%s ch=%s", tg_id, bot_id, ch["id"])
    except Exception as e:
        log.exception("my_chat_member handler failed: %s", e)
