"""TG-слушалка чатов событий — архив сообщений для подсчёта заданий.

⚠️ ОТДЕЛЬНО от слушалки ботов (start/funnel/chat_gate). Этот роутер ничего
   не отвечает людям и не шлёт уведомлений организатору — только:
     1) пишет каждое групповое сообщение чата СОБЫТИЯ в event_chat_messages
        (через app.services.chat_archive — он сам проверит, привязан ли чат);
     2) запоминает чаты, где бот админ, в bot_known_chats (для кнопки
        «Определить ID» в дашборде);
     3) команда /chatid в чате — бот отвечает числовым chat_id (точная привязка).

Порядок в Dispatcher: ПОСЛЕ chat_gate (гейт первым решает удалять/нет),
но это разные зоны — chat_gate работает на гейт-чатах, слушалка на чатах
событий; пересечение безопасно (оба только читают сообщение).

⚠️ Бот ОБЯЗАН быть админом чата + privacy mode OFF в @BotFather, иначе
   Telegram не отдаёт групповые сообщения боту.
"""
from __future__ import annotations

import logging

from aiogram import Bot, F, Router
from aiogram.types import ChatMemberUpdated, Message

from app.database import get_pool
from app.services.channels import find_channel_by_bot_id
from app.services.chat_archive import archive_chat_message, remember_known_chat

router = Router()
log = logging.getLogger(__name__)


async def _client_id_for_bot(bot_id: int, db) -> int | None:
    """client_id владельца бота (NULL для системного @pluson_bot)."""
    ch = await find_channel_by_bot_id(bot_id, db)
    if not ch or ch.get("is_system"):
        return None
    return await db.fetchval(
        "SELECT client_id FROM client_channels WHERE channel_id = $1 AND is_active = TRUE LIMIT 1",
        ch["id"],
    )


def _attachment_info(message: Message) -> tuple[bool, str | None]:
    """Есть ли вложение и какого рода."""
    if message.video:
        return True, "video"
    if message.video_note:
        return True, "video_note"
    if message.document:
        return True, "document"
    if message.photo:
        return True, "photo"
    if message.audio:
        return True, "audio"
    if message.voice:
        return True, "voice"
    if message.animation:
        return True, "animation"
    return False, None


@router.my_chat_member(F.chat.type.in_({"group", "supergroup"}))
async def on_added_to_chat(update: ChatMemberUpdated):
    """Бота добавили/сделали админом в группе → запомнить чат для кнопки «Определить ID»."""
    new_status = update.new_chat_member.status if update.new_chat_member else None
    if new_status not in ("member", "administrator"):
        return
    bot = update.bot
    can_read = new_status == "administrator"
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            client_id = await _client_id_for_bot(bot.id, db)
        await remember_known_chat(
            platform="telegram",
            chat_id=str(update.chat.id),
            title=update.chat.title,
            bot_id=str(bot.id),
            client_id=client_id,
            can_read=can_read,
        )
        log.info("chat_listener: бот %s в чате %s (%s), status=%s",
                 bot.id, update.chat.id, update.chat.title, new_status)
    except Exception as e:  # noqa: BLE001
        log.warning("chat_listener on_added_to_chat failed: %s", e)


@router.message(F.chat.type.in_({"group", "supergroup"}), F.text.in_({"/chatid", "/chatid@", "/getchatid"}))
async def cmd_chatid(message: Message, bot: Bot):
    """Команда /chatid в чате — бот отвечает числовым chat_id (точная привязка к событию)."""
    await message.reply(
        f"ID этого чата: <code>{message.chat.id}</code>\n\n"
        f"Скопируйте его в поле чата события в дашборде.",
        parse_mode="HTML",
    )
    # Заодно запомним чат (бот тут точно есть).
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            client_id = await _client_id_for_bot(bot.id, db)
        await remember_known_chat(
            platform="telegram", chat_id=str(message.chat.id), title=message.chat.title,
            bot_id=str(bot.id), client_id=client_id, can_read=True,
        )
    except Exception:  # noqa: BLE001
        pass


@router.message(F.chat.type.in_({"group", "supergroup"}))
async def on_group_message(message: Message, bot: Bot):
    """Каждое групповое сообщение → в архив, ЕСЛИ чат привязан к событию.

    archive_chat_message сам проверяет привязку (events.tg_chat_id == chat.id);
    если чат не наш — тихо выходит, ничего не пишет.
    """
    if not message.from_user or message.from_user.is_bot:
        return
    has_att, att_kind = _attachment_info(message)
    text = message.text or message.caption
    author = message.from_user
    author_name = " ".join(filter(None, [author.first_name, author.last_name])) or None
    sent_at = message.date  # aiogram отдаёт aware datetime (UTC)

    written = await archive_chat_message(
        platform="telegram",
        chat_id=str(message.chat.id),
        platform_user_id=str(author.id),
        username=author.username,
        author_name=author_name,
        text=text,
        has_attachment=has_att,
        attachment_kind=att_kind,
        message_ref=str(message.message_id),
        sent_at=sent_at,
    )
    # Если это чат события — заодно держим запись в known_chats свежей.
    if written:
        try:
            pool = await get_pool()
            async with pool.acquire() as db:
                client_id = await _client_id_for_bot(bot.id, db)
            await remember_known_chat(
                platform="telegram", chat_id=str(message.chat.id), title=message.chat.title,
                bot_id=str(bot.id), client_id=client_id, can_read=True,
            )
        except Exception:  # noqa: BLE001
            pass
