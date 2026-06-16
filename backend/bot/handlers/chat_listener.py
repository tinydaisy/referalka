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
from app.services.chat_archive import (
    archive_chat_message, remember_known_chat, process_task_submissions,
)

router = Router()
log = logging.getLogger(__name__)


async def _collect_tg_attachments(message: Message, bot: Bot) -> list[dict]:
    """Вложения сообщения → [{kind, url}] (ссылки через getFile, действуют ~1ч,
    но в дашборде ссылка пересобирается по file_id при показе — здесь храним url
    как быстрый доступ + file_id для долгого)."""
    out: list[dict] = []
    items: list[tuple[str, str]] = []
    if message.video:        items.append(("video", message.video.file_id))
    if message.video_note:   items.append(("video_note", message.video_note.file_id))
    if message.document:     items.append(("document", message.document.file_id))
    if message.photo:        items.append(("photo", message.photo[-1].file_id))
    if message.audio:        items.append(("audio", message.audio.file_id))
    if message.voice:        items.append(("voice", message.voice.file_id))
    if message.animation:    items.append(("animation", message.animation.file_id))
    for kind, fid in items:
        url = None
        try:
            f = await bot.get_file(fid)
            url = f"https://api.telegram.org/file/bot{bot.token}/{f.file_path}"
        except Exception:  # noqa: BLE001
            pass
        out.append({"kind": kind, "file_id": fid, "url": url})
    return out


async def _reply_unrecognized_tg(message: Message, info: dict) -> None:
    """Автор написал кодовую фразу, но не участник турнира — отвечаем ему
    в чат (reply) что он не зарегистрирован, со ссылкой на поддержку клиента."""
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            support = await db.fetchval(
                "SELECT work_tg_username FROM clients WHERE id = $1", info.get("client_id")
            )
        support_part = (
            f" Обратитесь к организатору: @{support.lstrip('@')}" if support else
            " Обратитесь к организатору."
        )
        await message.reply(
            "Похоже, вы не регистрировались на чемпионат, поэтому задание не засчитано."
            + support_part
        )
    except Exception as e:  # noqa: BLE001
        log.warning("reply unrecognized failed: %s", e)


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


@router.message(F.chat.type.in_({"group", "supergroup"}))
async def on_group_message(message: Message, bot: Bot):
    """Каждое групповое сообщение → в архив, ЕСЛИ чат привязан к событию.

    archive_chat_message сам проверяет привязку (events.tg_chat_id == chat.id);
    если чат не наш — тихо выходит, ничего не пишет.
    """
    if not message.from_user or message.from_user.is_bot:
        return

    # Команда /chatid — единственный случай, когда бот отвечает в чат: присылает
    # числовой ID этого чата (чтобы вписать в поле чата события в дашборде).
    # Срабатывает ТОЛЬКО на точное «/chatid» (с возможным @упоминанием бота).
    raw = (message.text or "").strip()
    cmd = raw.split("@", 1)[0].lower()
    if cmd == "/chatid":
        try:
            await message.reply(f"ID этого чата: <code>{message.chat.id}</code>", parse_mode="HTML")
        except Exception:  # noqa: BLE001
            pass
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
    if not written:
        return

    # ── Контроль заданий: ищем кодовые фразы критериев → балл + лог.
    atts = await _collect_tg_attachments(message, bot)
    try:
        unrecognized = await process_task_submissions(
            platform="telegram",
            chat_id=str(message.chat.id),
            platform_user_id=str(author.id),
            username=author.username,
            author_name=author_name,
            text=text,
            attachments=atts,
            message_ref=str(message.message_id),
            sent_at=sent_at,
        )
        # Неопознанным — ответ «вы не регистрировались» (один раз на сообщение).
        if unrecognized:
            await _reply_unrecognized_tg(message, unrecognized[0])
    except Exception as e:  # noqa: BLE001
        log.warning("chat_listener task submissions failed: %s", e)

    # Держим запись в known_chats свежей.
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
