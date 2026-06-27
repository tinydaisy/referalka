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
import time
from html import escape

from aiogram import Bot, F, Router
from aiogram.enums import ParseMode
from aiogram.dispatcher.event.bases import SkipHandler
from aiogram.types import Message

from app.database import get_pool
from app.services.channels import find_channel_by_bot_id
from app.services.funnel_service import check_telegram_channels_subscription

router = Router()
log = logging.getLogger(__name__)

# In-memory кеш ТОЛЬКО для отрицательных решений («не подписан»).
# Кешировать «подписан» опасно: юзер мог пройти проверку, потом отписаться,
# а кеш бы 60 сек пропускал его сообщения — это пробой гейта. Поэтому
# для «подписан» каждый раз делаем полную проверку (это безопасный путь),
# а для спамеров-не-подписанных короткий кеш экономит API-запросы и
# ускоряет повторные удаления.
#
# Ключ: (chat_id_str, user_id). Значение: (expires_at, missing_channels).
# missing_channels хранится чтобы повторное удаление использовало тот же
# список «подпишитесь на канал X, Y, Z» без повторного фетча БД.
_NOT_SUBSCRIBED_CACHE: dict[tuple[str, int], tuple[float, list[dict]]] = {}
_CACHE_TTL_SEC = 60.0
_CACHE_MAX = 5000  # защита от бесконечного роста


def _get_cached_not_subscribed(chat_id: str, user_id: int) -> list[dict] | None:
    """Если юзер недавно был помечен «не подписан» и кеш не протух — возвращает
    список missing-каналов. Иначе None."""
    entry = _NOT_SUBSCRIBED_CACHE.get((chat_id, user_id))
    if entry is None:
        return None
    expires_at, missing = entry
    if expires_at < time.monotonic():
        _NOT_SUBSCRIBED_CACHE.pop((chat_id, user_id), None)
        return None
    return missing


def _mark_not_subscribed(chat_id: str, user_id: int, missing: list[dict]) -> None:
    if len(_NOT_SUBSCRIBED_CACHE) >= _CACHE_MAX:
        now = time.monotonic()
        expired = [k for k, (exp, _) in _NOT_SUBSCRIBED_CACHE.items() if exp < now]
        for k in expired:
            _NOT_SUBSCRIBED_CACHE.pop(k, None)
        if len(_NOT_SUBSCRIBED_CACHE) >= _CACHE_MAX:
            _NOT_SUBSCRIBED_CACHE.clear()
    _NOT_SUBSCRIBED_CACHE[(chat_id, user_id)] = (
        time.monotonic() + _CACHE_TTL_SEC,
        missing,
    )


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
    # Системный @pluson_bot НЕ обслуживает гейты подписки клиентов — гейт работает
    # только через собственный VIP-бот клиента. Системный остаётся лишь для самого
    # ПЛЮСОНа (личка/техподдержка). Отсекаем по токену.
    from app.config import settings
    if settings.telegram_bot_token and bot.token == settings.telegram_bot_token:
        raise SkipHandler()
    chat_id_str = str(message.chat.id)
    user_id = message.from_user.id
    t_start = time.monotonic()

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
            # Не гейт-чат → пробрасываем сообщение дальше, чтобы его увидела
            # слушалка заданий (chat_listener, зарегистрирована ПОСЛЕ гейта).
            # Без SkipHandler aiogram считает событие обработанным и не передаёт
            # следующим роутерам → чаты событий не архивировались.
            raise SkipHandler()

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
                    # Этот канал гейта не принадлежит клиенту бота — гейт не наш,
                    # но сообщение всё равно пробрасываем дальше (chat_listener).
                    raise SkipHandler()
        # (системный @pluson_bot сюда не доходит — отсечён по токену в начале хендлера)

        # 3) Быстрый путь: если этот юзер недавно (≤60 сек) уже был помечен «не подписан»
        # для этого чата — пропускаем дорогостоящий getChatMember и берём список missing
        # из кеша. Это ускоряет удаление спама с одного аккаунта (10 сообщений подряд
        # → только 1 проверка getChatMember).
        cached_missing = _get_cached_not_subscribed(chat_id_str, user_id)
        if cached_missing is not None:
            sub = {"ok": False, "missing": cached_missing, "bot_not_in": [], "no_token": False, "no_channels": False}
        else:
            # 3b) Полная проверка подписки на все TG-каналы основателя.
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
            # Сообщение не удаляем — пробрасываем дальше в chat_listener (контроль
            # заданий/приветствия), иначе в чате с гейтом задания не слушаются.
            raise SkipHandler()

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
            raise SkipHandler()

        if sub.get("ok"):
            # «Подписан» НЕ кешируем — юзер мог отписаться, гейт не должен его пропускать.
            log.info(
                "chat_gate: gate=%s chat=%s user=%s ALLOW in %.2fs → SkipHandler",
                gate["id"], chat_id_str, user_id, time.monotonic() - t_start,
            )
            # Подписчик прошёл гейт — сообщение валидно, пробрасываем его дальше
            # в chat_listener (контроль заданий + приветствия). Без SkipHandler
            # aiogram считал бы апдейт обработанным и слушалка заданий его не видела.
            raise SkipHandler()

        # 4) Запомним «не подписан» на 60 сек вместе со списком missing.
        # Следующее сообщение этого юзера в этом чате пройдёт мимо
        # getChatMember и сразу пойдёт на delete+warn. Если он за эту минуту
        # подписался — досадно (одно сообщение зря удалится), но не критично:
        # через минуту проверка свежая.
        # Если в текущем запросе мы использовали кеш (cached_missing!=None),
        # повторная запись просто продлит TTL — это окей.
        missing = sub.get("missing") or []
        _mark_not_subscribed(chat_id_str, user_id, missing)

        # 5) Не подписан хоть на один — параллельно: удаляем сообщение + готовим
        # предупреждение + достаём имя основателя из БД. delete и send выполняются
        # одновременно через asyncio.gather — это экономит ~500ms (раньше было
        # последовательно). reply_to_message_id указывает на УЖЕ удалённое сообщение —
        # Telegram это поддерживает, предупреждение визуально привязывается к нарушителю.
        channel_lines: list[str] = []
        for ch in missing:
            name = (ch.get("name") or "").strip()
            url = (ch.get("url") or "").strip()
            if not url:
                continue
            channel_lines.append(f"• {name}: {url}" if name else f"• {url}")

        # «Имя обращения»: first_name + (опционально) «(@username)» — чтобы человек сразу видел
        # что обращение именно к нему.
        first = (message.from_user.first_name or "").strip()
        username = (message.from_user.username or "").strip()
        if first and username:
            user_name = f"{first} (@{username})"
        elif first:
            user_name = first
        elif username:
            user_name = f"@{username}"
        else:
            user_name = "Друг"

        founder_name = await db.fetchval(
            "SELECT name FROM clients WHERE id = $1", gate["client_id"]
        ) or ""
        warning_text = _render_warning(
            gate["warning_text"],
            user_name=user_name,
            channel_url_lines=channel_lines,
            founder_name=founder_name,
        )

        async def _do_delete():
            try:
                await bot.delete_message(chat_id=message.chat.id, message_id=message.message_id)
            except Exception as e:
                log.warning("chat_gate: delete_message failed for gate=%s: %s", gate["id"], e)

        async def _do_warn():
            # reply_to_message_id указывает на сообщение, которое мы тут же удаляем
            # (_do_delete). Из-за гонки Telegram часто отвечает «message to be
            # replied not found» — тогда предупреждение НЕ уходит, и человек видит
            # лишь молчаливое удаление. Поэтому: пробуем с reply, а при этой ошибке
            # шлём ОБЫЧНЫМ сообщением в чат (без reply) — предупреждение придёт всегда.
            warn = None
            try:
                warn = await bot.send_message(
                    chat_id=message.chat.id,
                    text=warning_text,
                    reply_to_message_id=message.message_id,
                    parse_mode=ParseMode.HTML,
                )
            except Exception as e:
                low = str(e).lower()
                if "reply" in low or "not found" in low:
                    # сообщение-цель уже удалено — шлём без привязки
                    try:
                        warn = await bot.send_message(
                            chat_id=message.chat.id,
                            text=warning_text,
                            parse_mode=ParseMode.HTML,
                        )
                    except Exception as e2:
                        log.warning("chat_gate: send warning (no-reply) failed for gate=%s: %s", gate["id"], e2)
                else:
                    log.warning("chat_gate: send warning failed for gate=%s: %s", gate["id"], e)
            if warn is not None:
                asyncio.create_task(
                    _delete_later(bot, message.chat.id, warn.message_id, gate["warning_ttl_sec"])
                )

        # Сначала отправляем предупреждение (пытаясь reply на ещё-живое сообщение),
        # ПОТОМ удаляем — так reply чаще успевает привязаться, а при сбое
        # сработает фолбэк без reply. Порядок важен: не gather.
        await _do_warn()
        await _do_delete()

        log.info(
            "chat_gate: gate=%s user=%s DELETE+WARN in %.2fs (missing=%d)",
            gate["id"], user_id, time.monotonic() - t_start, len(missing),
        )
