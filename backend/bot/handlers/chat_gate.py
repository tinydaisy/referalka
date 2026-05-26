"""Гейт по подписке в Telegram-чатах (миграция 115).

Что делает:
  При каждом сообщении в group/supergroup ищет запись `client_chat_gates`
  по `chat.id`. Если гейт активен — проверяет подписку автора на ВСЕ
  TG-каналы основателя клиента (из `clients.social_links->'telegram_channels'`).

  Если хоть один канал недоступен боту (бот сам не админ / канал удалён) —
  гейт автоматически выключается (`is_active = FALSE`), сообщение НЕ удаляется,
  в дашборде клиент увидит причину автоотключения. Это сознательный fail-open:
  лучше пропустить лишнее, чем удалить честное сообщение.

  Если на все каналы подписан — пропускаем.

  Иначе удаляем сообщение и шлём предупреждение со списком неподписанных каналов
  как reply на удалённое сообщение. Авто-удаление предупреждения через TTL.

⚠️ У бота должен быть отключён privacy mode в @BotFather. Без этого Telegram
   присылает только сообщения с упоминанием/reply.
"""
from __future__ import annotations

import asyncio
import logging
from html import escape

from aiogram import Bot, F, Router
from aiogram.enums import ParseMode
from aiogram.types import Message

from app.database import get_pool
from app.services.channels import find_channel_by_bot_id
from app.services.funnel_service import check_telegram_channels_subscription

router = Router()
log = logging.getLogger(__name__)


DEFAULT_WARNING_TEMPLATE = (
    "{user_name}, чтобы писать в этот чат, подпишитесь на канал(ы) основателя:\n{channels_list}"
)


def _render_warning(
    template: str | None,
    *,
    user_name: str,
    channel_url_lines: list[str],
    founder_name: str,
) -> str:
    """Подставляет плейсхолдеры в шаблон предупреждения.

    Плейсхолдеры:
      {user_name}     — имя автора удалённого сообщения
      {channels_list} — список каналов «• Имя: URL» через перенос
      {founder_name}  — имя основателя (clients.name)
      {channel_url}   — первый URL (legacy, для совместимости со старым шаблоном)
    """
    tpl = (template or "").strip() or DEFAULT_WARNING_TEMPLATE
    channels_list = "\n".join(channel_url_lines)
    first_url = ""
    for ln in channel_url_lines:
        # формат "• Name: url" или просто "url" — берём подстроку после ': '
        if ": " in ln:
            first_url = ln.split(": ", 1)[1].strip()
        else:
            first_url = ln.lstrip("• ").strip()
        if first_url:
            break
    out = tpl
    out = out.replace("{user_name}", escape(user_name))
    out = out.replace("{channels_list}", escape(channels_list))
    out = out.replace("{founder_name}", escape(founder_name))
    out = out.replace("{channel_url}", escape(first_url))
    return out


async def _delete_later(bot: Bot, chat_id: int | str, message_id: int, ttl_sec: int) -> None:
    await asyncio.sleep(max(5, int(ttl_sec or 15)))
    try:
        await bot.delete_message(chat_id=chat_id, message_id=message_id)
    except Exception as e:
        log.info("chat_gate: delete warning failed (ok, can be ignored): %s", e)


@router.message(F.chat.type.in_({"group", "supergroup"}))
async def handle_group_message(message: Message, bot: Bot):
    """Каждое сообщение в группе/супергруппе — проверка подписки автора."""
    if not message.from_user or message.from_user.is_bot:
        return
    chat_id_str = str(message.chat.id)
    pool = await get_pool()
    async with pool.acquire() as db:
        # 1) Ищем активный гейт для этого чата.
        gate = await db.fetchrow(
            """SELECT id, client_id, warning_text, warning_ttl_sec
                 FROM client_chat_gates
                WHERE chat_id = $1 AND is_active = TRUE""",
            chat_id_str,
        )
        if not gate:
            return

        # 2) Защита: бот, обрабатывающий сообщение, должен принадлежать клиенту
        # (либо системному). Если в Dispatcher крутится бот другого клиента —
        # его обработчик не должен трогать чат, привязанный к Маргарите.
        bot_channel = await find_channel_by_bot_id(bot.id, db)
        if bot_channel:
            # Не системный → должен совпадать с client_id гейта
            if not bot_channel["is_system"]:
                # Доступен ли этот канал клиенту-владельцу гейта?
                client_owns = await db.fetchval(
                    """SELECT 1 FROM client_channels
                        WHERE client_id = $1 AND channel_id = $2 LIMIT 1""",
                    gate["client_id"], bot_channel["id"],
                )
                if not client_owns:
                    return
        # Системный @pluson_bot — обрабатывает гейты любых клиентов на bare-тарифе.

        # 3) Параллельная проверка подписки на все TG-каналы основателя.
        sub = await check_telegram_channels_subscription(
            gate["client_id"], str(message.from_user.id), db
        )

        # Бот сам не админ хоть в одном канале → автоматически выключаем гейт.
        # Сообщение НЕ удаляем, юзер пишет (fail-open).
        if sub.get("bot_not_in"):
            names = [ch.get("name") or ch.get("url") or "" for ch in sub["bot_not_in"]]
            err = "Бот не админ в канале(ах): " + ", ".join(filter(None, names))
            await db.execute(
                """UPDATE client_chat_gates
                      SET is_active = FALSE, last_error = $1, last_error_at = NOW()
                    WHERE id = $2""",
                err, gate["id"],
            )
            log.info("chat_gate: auto-off gate=%s reason=%s", gate["id"], err)
            return

        if sub.get("no_channels"):
            # У клиента нет каналов основателя — нечего проверять.
            await db.execute(
                """UPDATE client_chat_gates
                      SET is_active = FALSE,
                          last_error = 'Не настроены каналы основателя',
                          last_error_at = NOW()
                    WHERE id = $1""",
                gate["id"],
            )
            return

        if sub.get("ok"):
            return  # подписан на все — пропускаем

        # 4) Не подписан хоть на один — удаляем сообщение + предупреждение.
        try:
            await bot.delete_message(chat_id=message.chat.id, message_id=message.message_id)
        except Exception as e:
            log.warning("chat_gate: delete_message failed for gate=%s: %s", gate["id"], e)

        # Имя основателя и список неподписанных каналов
        founder_name = await db.fetchval(
            "SELECT name FROM clients WHERE id = $1", gate["client_id"]
        ) or ""
        missing = sub.get("missing") or []
        channel_lines: list[str] = []
        for ch in missing:
            name = (ch.get("name") or "").strip()
            url = (ch.get("url") or "").strip()
            if not url:
                continue
            channel_lines.append(f"• {name}: {url}" if name else f"• {url}")

        user_name = message.from_user.first_name or message.from_user.username or "Друг"
        warning_text = _render_warning(
            gate["warning_text"],
            user_name=user_name,
            channel_url_lines=channel_lines,
            founder_name=founder_name,
        )

        try:
            warn = await bot.send_message(
                chat_id=message.chat.id,
                text=warning_text,
                # reply_to_message_id указывает на УЖЕ удалённое сообщение — Telegram
                # это поддерживает, предупреждение визуально привязывается к нарушителю.
                reply_to_message_id=message.message_id,
                parse_mode=ParseMode.HTML,
            )
            asyncio.create_task(
                _delete_later(bot, message.chat.id, warn.message_id, gate["warning_ttl_sec"])
            )
        except Exception as e:
            log.warning("chat_gate: send warning failed for gate=%s: %s", gate["id"], e)
