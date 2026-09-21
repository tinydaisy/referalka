"""Закреп сообщения в чате — единая точка на три площадки.

Закреплять умеют все три: Telegram `pinChatMessage`, ВКонтакте `messages.pin`,
MAX `PUT /chats/{chatId}/pin`. Требование общее — бот должен быть
администратором чата (в Telegram при автонастройке право на закреп боту уже
выдаётся, см. `tg_setup.py`).

⚠️ Неудачный закреп НЕ считается ошибкой отправки. Сообщение уже доставлено
людям; молча терять его из-за того, что боту не дали прав, нельзя. Поэтому
каждая функция возвращает `(ok, error)` и НИКОГДА не поднимает исключение —
вызывающий пишет предупреждение в лог и идёт дальше.

⚠️ ВКонтакте закрепляет по `conversation_message_id`, а НЕ по тому
`message_id`, который возвращает `messages.send`. Это разные нумерации: первая
локальная внутри беседы, вторая сквозная по сообществу. Передача `message_id`
в `messages.pin` молча закрепила бы чужое сообщение или ответила ошибкой,
поэтому id беседы запрашивается отдельно (`messages.getByMessageId`).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


async def pin_telegram(bot_token: str, chat_id: str | int, message_id: int | str,
                       *, notify: bool = False) -> tuple[bool, str]:
    """Закрепить в Telegram-чате.

    notify=False — закрепляем ТИХО: навигация вешается в закреп один раз и
    звонить всему чату ради этого незачем.
    """
    if not bot_token or not chat_id or not message_id:
        return False, "нет токена, чата или id сообщения"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"https://api.telegram.org/bot{bot_token}/pinChatMessage",
                json={
                    "chat_id": str(chat_id),
                    "message_id": int(message_id),
                    "disable_notification": not notify,
                },
            )
        data = r.json() if r.content else {}
        if data.get("ok"):
            return True, ""
        return False, str(data.get("description") or f"HTTP {r.status_code}")
    except Exception as ex:          # сеть/таймаут/кривой ответ
        return False, str(ex)


async def pin_vk(token: str, peer_id: int | str,
                 conversation_message_id: int | str) -> tuple[bool, str]:
    """Закрепить в беседе ВКонтакте.

    `peer_id` беседы — полный (2000000000+local), именно так он и хранится у
    чата события. `conversation_message_id` — НЕ `message_id` (см. модуль).
    """
    if not token or not peer_id or not conversation_message_id:
        return False, "нет токена, беседы или id сообщения"
    try:
        from app.services.vk_api import vk_call
        await vk_call("messages.pin", {
            "peer_id": int(peer_id),
            "conversation_message_id": int(conversation_message_id),
        }, token=token)
        return True, ""
    except Exception as ex:
        return False, str(ex)


async def vk_conversation_message_id(token: str, peer_id: int | str,
                                     message_id: int | str) -> Optional[int]:
    """`message_id` → `conversation_message_id` той же беседы.

    `messages.send` возвращает сквозной id сообщества, а закреп работает по
    локальному id беседы. Преобразование делает сам ВКонтакте.
    """
    if not token or not message_id:
        return None
    try:
        from app.services.vk_api import vk_call
        resp = await vk_call("messages.getByMessageId", {
            "message_ids": int(message_id),
        }, token=token)
        items = (resp or {}).get("items") or []
        if items:
            cmid = items[0].get("conversation_message_id")
            return int(cmid) if cmid else None
    except Exception as ex:
        logger.warning(f"VK: не удалось получить conversation_message_id: {ex}")
    return None


async def pin_max(token: str, chat_id: int | str, mid: str,
                  *, notify: bool = False) -> tuple[bool, str]:
    """Закрепить в чате MAX (`PUT /chats/{chatId}/pin`)."""
    if not token or not chat_id or not mid:
        return False, "нет токена, чата или id сообщения"
    try:
        from app.services.max_api import max_call
        await max_call(
            "PUT", f"/chats/{chat_id}/pin",
            token=token,
            json_body={"message_id": str(mid), "notify": bool(notify)},
        )
        return True, ""
    except Exception as ex:
        return False, str(ex)


def max_message_id(resp: Any) -> Optional[str]:
    """Вытащить `mid` отправленного сообщения из ответа MAX.

    Ответ `POST /messages` — `{"message": {"body": {"mid": "...", ...}, ...}}`,
    та же форма, что у входящих апдейтов (`max_webhook.py`).
    """
    if not isinstance(resp, dict):
        return None
    body = ((resp.get("message") or {}).get("body") or {})
    mid = body.get("mid")
    return str(mid) if mid else None
