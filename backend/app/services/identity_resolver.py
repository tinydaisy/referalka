"""
identity_resolver.py — резолв `@username` коллаба → числовой `platform_user_id`.

Используется при создании коллаба, когда организатор знает только TG/VK/MAX
никнейм, но не числовой id. Подробности — `project_collaborator_pseudo_platform_users.md`.

Логика:
- TG: `getChat(@username)` через бот клиента (или системный). Работает только
  если юзер хоть раз писал боту. Для рядового спикера почти всегда вернёт
  `Bad Request: chat not found`.
- VK: `users.get?user_ids={screen_name}` через системный токен — работает в
  большинстве случаев (публичный API).
- MAX: пока без публичного API — всегда None.

Возвращает (resolved_id, is_subscribed):
- resolved_id: str | None — реальный платформенный id если получилось резолвить.
- is_subscribed: bool — подписан ли юзер на главный канал клиента (для TG —
  не блокировал ли бот; для VK — `groups.isMember`).
"""

from __future__ import annotations

import logging
from typing import Optional, Tuple

import httpx

log = logging.getLogger(__name__)


async def resolve_personal_identity(
    db,
    *,
    client_id: int,
    platform_slug: str,
    username: str,
) -> Tuple[Optional[str], bool]:
    """Резолвит @username → (platform_user_id, is_subscribed) для данной платформы.

    Если резолв не удался — (None, False). Caller сам решит создавать псевдо-
    запись с placeholder-id `@<username>` и `is_unsubscribed=TRUE`.

    Никогда не кидает исключения — ошибки логируются и возвращается (None, False).
    """
    uname = (username or "").lstrip("@").strip()
    if not uname:
        return None, False

    try:
        if platform_slug == "telegram":
            return await _resolve_tg(db, client_id, uname)
        if platform_slug == "vk":
            return await _resolve_vk(uname)
        # MAX — пока нет публичного API для резолва ника в id.
        return None, False
    except Exception as e:
        log.warning("resolve_personal_identity(%s, @%s) failed: %s", platform_slug, uname, e)
        return None, False


# ─── Telegram ───────────────────────────────────────────────────────────────


async def _resolve_tg(db, client_id: int, username: str) -> Tuple[Optional[str], bool]:
    """getChat(@username) через бот клиента (или системный @pluson_bot).

    is_subscribed=True если getChat вернул `type='private'` (значит юзер
    есть в чате с ботом — раньше писал). type='group'/'supergroup' — это
    канал, не юзер. type='private' с `id > 0` — точно юзер.
    """
    from app.services.channels import get_client_telegram_token
    from app.config import settings

    token = await get_client_telegram_token(client_id, db)
    if not token:
        token = getattr(settings, "telegram_bot_token", "") or getattr(settings, "TELEGRAM_BOT_TOKEN", "")
    if not token:
        return None, False

    try:
        async with httpx.AsyncClient(timeout=10.0) as cli:
            r = await cli.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": f"@{username}"},
            )
        data = r.json()
        if not data.get("ok"):
            # Самый частый кейс: "Bad Request: chat not found" — юзер не
            # писал боту. Нормально, fallback на псевдо-запись.
            return None, False
        result = data.get("result", {})
        chat_type = result.get("type")
        chat_id = result.get("id")
        if not chat_id:
            return None, False
        # type='private' с положительным id = персональный чат с юзером,
        # значит он реально подписался на бота (нажал /start).
        is_user_chat = chat_type == "private" and int(chat_id) > 0
        return str(chat_id), is_user_chat
    except Exception as e:
        log.info("_resolve_tg getChat @%s failed: %s", username, e)
        return None, False


# ─── VK ─────────────────────────────────────────────────────────────────────


async def _resolve_vk(screen_name: str) -> Tuple[Optional[str], bool]:
    """users.get?user_ids={screen_name} → numeric user_id.

    is_subscribed=True если у клиента есть подключённое VK-сообщество и
    `groups.isMember` вернул True. Пока для простоты — False, флаг подписки
    выставляется при первом сообщении в сообщество (через VK Long Poll).
    """
    try:
        from app.services.vk_api import vk_call
    except Exception:
        return None, False

    try:
        resp = await vk_call("users.get", {"user_ids": screen_name})
    except Exception as e:
        log.info("_resolve_vk users.get %s failed: %s", screen_name, e)
        return None, False

    # resp — список объектов; берём первый.
    if not isinstance(resp, list) or not resp:
        return None, False
    user = resp[0]
    user_id = user.get("id")
    if not user_id:
        return None, False
    # is_subscribed на сообщество клиента — проверяем отдельно (требует
    # vk_group_id клиента и group token). Пока возвращаем False — флаг
    # пользователь сам обновит когда напишет первое сообщение в сообщество.
    return str(user_id), False


async def fetch_telegram_profile(db, client_id: int, tg_id) -> dict:
    """По ЧИСЛОВОМУ id аккаунта достаём ник и имя через getChat.

    ⚠️ Нужно потому, что Telegram отдаёт неполные данные, когда Mini App
    открывают кнопкой, не заходя в бота: приходит только id, ник и имя
    пустые — и контакт создаётся безымянным. Сам Telegram эти данные знает,
    достаточно спросить.

    Работает, если человек когда-либо писал боту клиента (иначе Telegram
    отвечает «chat not found» — тогда просто вернём пустой словарь).
    """
    from app.services.channels import get_client_telegram_token

    token = await get_client_telegram_token(client_id, db)
    if not token or not tg_id:
        return {}
    try:
        async with httpx.AsyncClient(timeout=8.0) as cli:
            r = await cli.get(
                f"https://api.telegram.org/bot{token}/getChat",
                params={"chat_id": str(tg_id)},
            )
        data = r.json()
        if not data.get("ok"):
            return {}
        res = data.get("result") or {}
        return {
            "username": (res.get("username") or "").lstrip("@") or None,
            "first_name": res.get("first_name") or None,
            "last_name": res.get("last_name") or None,
        }
    except Exception as e:  # noqa: BLE001 — сеть/таймаут не должны ронять вход
        log.warning("getChat(%s) не удался: %s", tg_id, e)
        return {}
