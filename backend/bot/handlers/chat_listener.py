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
    process_chat_greeting,
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


async def _reply_submission_tg(message: Message, info: dict) -> None:
    """Авто-ответ автору (reply) после сдачи задания — «✅ Принято: …»."""
    from app.services.chat_archive import build_submission_reply_text
    txt = build_submission_reply_text(info, html=True)
    if not txt:
        return
    try:
        await message.reply(txt, parse_mode="HTML")
    except Exception as e:  # noqa: BLE001
        log.warning("reply submission failed: %s", e)


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


# Статусы, означающие «человек в чате» / «человека нет в чате».
_IN_CHAT_STATUSES = {"member", "administrator", "creator", "restricted"}
_OUT_CHAT_STATUSES = {"left", "kicked"}


@router.chat_member(F.chat.type.in_({"group", "supergroup"}))
async def on_member_changed(update: ChatMemberUpdated):
    """Любой участник вошёл/вышел из группы → авто-метим event_participants.is_in_chat.

    Работает ТОЛЬКО для Telegram-чата, привязанного к событию (events.tg_chat_ref
    → client_broadcast_chats.chat_id == этот чат). Бот обязан быть админом, иначе
    Telegram не шлёт chat_member про обычных людей.

    VK/MAX аналога нет — там членство в беседе через API не отслеживается.
    """
    member = update.new_chat_member
    if not member or not member.user or member.user.is_bot:
        return
    new_status = member.status
    if new_status in _IN_CHAT_STATUSES:
        is_in = True
    elif new_status in _OUT_CHAT_STATUSES:
        is_in = False
    else:
        return  # неизвестный статус — не трогаем

    tg_id = str(member.user.id)
    chat_id = str(update.chat.id)
    try:
        pool = await get_pool()
        async with pool.acquire() as db:
            # Все события, чей Telegram-чат = этот чат (через ref на базу чатов).
            event_ids = await db.fetch(
                """SELECT e.id
                     FROM events e
                     JOIN client_broadcast_chats cbc ON cbc.id = e.tg_chat_ref
                    WHERE cbc.platform = 'telegram' AND cbc.chat_id = $1""",
                chat_id,
            )
            if not event_ids:
                return  # чат не привязан ни к одному событию
            ids = [r["id"] for r in event_ids]
            # Метим участника по его telegram-идентичности в этих событиях.
            updated = await db.fetch(
                """UPDATE event_participants ep
                      SET is_in_chat = $1, chat_check_at = NOW()
                     FROM platform_users pu
                    WHERE pu.contact_id = ep.contact_id
                      AND pu.platform_slug = 'telegram'
                      AND pu.platform_user_id = $2
                      AND ep.event_id = ANY($3::int[])
                  RETURNING ep.id""",
                is_in, tg_id, ids,
            )
        if updated:
            log.info("chat_listener: chat_member tg=%s chat=%s → is_in_chat=%s (%d участ.)",
                     tg_id, chat_id, is_in, len(updated))
    except Exception as e:  # noqa: BLE001
        log.warning("chat_listener on_member_changed failed: %s", e)


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
    # /chatid отвечает любой бот (нужно при первичной настройке, события ещё нет).
    raw = (message.text or "").strip()
    cmd = raw.split("@", 1)[0].lower()
    if cmd == "/chatid":
        try:
            await message.reply(f"ID этого чата: <code>{message.chat.id}</code>", parse_mode="HTML")
        except Exception:  # noqa: BLE001
            pass
        return

    # ── СИСТЕМНЫЙ @pluson_bot НЕ обрабатывает чаты СОБЫТИЙ ──
    # Приветствия и контроль заданий в чатах турниров/конференций — фича VIP:
    # их обслуживает ТОЛЬКО собственный бот клиента. Системный @pluson_bot сидит
    # во многих чатах (гейт подписки), но отвечать/начислять по заданиям и слать
    # приветствия НЕ должен — иначе в чате клиента торчит «ПЛЮСОН». Отсекаем по токену.
    from app.config import settings
    if settings.telegram_bot_token and bot.token == settings.telegram_bot_token:
        return

    log.info("chat_listener: got group msg chat=%s user=%s bot=%s text=%r",
             message.chat.id, message.from_user.id, bot.id, (message.text or message.caption or "")[:40])

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

    # ── Приветствие в чатах: кодовое слово → ОТВЕТ случайной фразой (reply),
    # но не мгновенно: через случайную задержку 30..180 сек (естественнее).
    # Запускаем фоном, чтобы не держать обработку апдейта.
    try:
        greeting = await process_chat_greeting(
            platform="telegram",
            chat_id=str(message.chat.id),
            author_name=author_name,
            username=author.username,
            text=text,
        )
        if greeting:
            import asyncio
            from app.services.chat_archive import pick_greeting_delay_sec
            delay = pick_greeting_delay_sec()

            async def _send_greeting_later(msg=message, txt=greeting, d=delay):
                try:
                    await asyncio.sleep(d)
                    await msg.reply(txt)
                except Exception as ex:  # noqa: BLE001
                    log.warning("chat_listener delayed greeting failed: %s", ex)

            asyncio.create_task(_send_greeting_later())
    except Exception as e:  # noqa: BLE001
        log.warning("chat_listener greeting failed: %s", e)

    # ── Контроль заданий: ищем кодовые фразы критериев → балл + лог.
    atts = await _collect_tg_attachments(message, bot)
    try:
        submissions = await process_task_submissions(
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
        # Авто-ответ автору: «✅ Принято: …» (или «не зарегистрированы») +
        # напоминание прислать повторно новым сообщением. Один на сообщение.
        if submissions:
            await _reply_submission_tg(message, submissions[0])
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
