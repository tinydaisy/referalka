"""my_chat_member handler — ловит блокировку/разблокировку бота пользователем.

Telegram шлёт `my_chat_member` каждый раз когда статус бота в чате меняется:
- *→kicked / left  → юзер заблокировал/удалил бота → пометить отписку
- kicked→member    → юзер разблокировал → re-subscribe

Архитектура G:
  Один tg_id может быть подписан на канал в РАЗНЫХ контекстах клиентов
  (особенно для общего @pluson_bot — Маргариты + Романа + системного).
  При блокировке бота отписка должна сработать ВО ВСЕХ контекстах: бот реально
  заблокирован, никаким клиентом сообщения дойти не могут.
"""
import logging
from aiogram import Router
from aiogram.types import ChatMemberUpdated
from app.database import get_pool
from app.services.channels import (
    find_channel_by_bot_id,
    mark_unsubscribed_globally,
    resubscribe_globally,
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
                # Глобальная отписка: во всех контекстах подписки на этот канал
                count = await mark_unsubscribed_globally(ch["id"], tg_id, db)
                log.info(
                    "subscription: %s заблокировал bot=%s ch=%s (отписано записей: %d)",
                    tg_id, bot_id, ch["id"], count
                )
            elif new_status == "member":
                # Глобальная re-подписка: возвращаем подписку во всех контекстах
                count = await resubscribe_globally(ch["id"], tg_id, db)
                log.info(
                    "subscription: %s разблокировал bot=%s ch=%s (восстановлено записей: %d)",
                    tg_id, bot_id, ch["id"], count
                )
    except Exception as e:
        log.exception("my_chat_member handler failed: %s", e)
