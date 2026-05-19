"""
Клиент VK API для отправки сообщений и работы с сообществом.

Аналог `bot/main.py` (Telegram), но через HTTP-вызовы VK API. Используется сервисом
event_welcome и tasks/broadcast для рассылок участникам в личку от сообщества.

Документация: https://dev.vk.com/ru/method/messages.send
"""
from __future__ import annotations

import json
import logging
import random
from typing import Any, Iterable

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

VK_API_VERSION = "5.199"
VK_API_BASE = "https://api.vk.com/method"


async def vk_call(method: str, params: dict[str, Any], *, token: str | None = None) -> dict[str, Any]:
    """Низкоуровневый вызов VK API. Возвращает поле `response`.

    Кидает RuntimeError если VK вернул `error`.
    """
    token = token or settings.vk_system_group_token
    if not token:
        raise RuntimeError("VK_SYSTEM_GROUP_TOKEN not set")
    payload = {**params, "access_token": token, "v": VK_API_VERSION}
    async with httpx.AsyncClient(timeout=15.0) as cli:
        r = await cli.post(f"{VK_API_BASE}/{method}", data=payload)
    data = r.json()
    if "error" in data:
        err = data["error"]
        raise RuntimeError(f"VK API {method} error {err.get('error_code')}: {err.get('error_msg')}")
    return data.get("response", {})


async def send_message(
    user_vk_id: int,
    text: str,
    *,
    token: str | None = None,
    keyboard: dict | None = None,
    attachment: str | None = None,
) -> int | None:
    """Отправить личное сообщение от сообщества пользователю с vk_id.

    :param keyboard: VK keyboard JSON dict (см. https://dev.vk.com/ru/api/bots/development/keyboard)
    :param attachment: строка типа `photo123_456` для прикрепления медиа
    :return: message_id или None если упало
    """
    params: dict[str, Any] = {
        "user_id": user_vk_id,
        "message": text,
        "random_id": random.randint(1, 2**31 - 1),
        "dont_parse_links": 0,
    }
    if keyboard:
        params["keyboard"] = json.dumps(keyboard, ensure_ascii=False)
    if attachment:
        params["attachment"] = attachment
    try:
        resp = await vk_call("messages.send", params, token=token)
        if isinstance(resp, int):
            return resp
        return resp.get("message_id") if isinstance(resp, dict) else None
    except RuntimeError as e:
        logger.warning(f"VK send_message failed for user={user_vk_id}: {e}")
        return None


def tg_inline_to_vk_keyboard(buttons: list[list[dict]]) -> dict:
    """Конвертер Telegram inline-кнопок в VK keyboard.

    Telegram: [[{"text": "X", "url": "https://..."}], ...]  или
              [[{"text": "X", "callback_data": "..."}], ...]
    VK: {"inline": true, "buttons": [[{"action": {"type": "open_link", "link": "...", "label": "X"}}]]}
    """
    vk_rows = []
    for row in buttons:
        vk_row = []
        for btn in row:
            label = btn.get("text", "")
            if "url" in btn:
                vk_row.append({"action": {"type": "open_link", "link": btn["url"], "label": label}})
            elif "callback_data" in btn:
                vk_row.append({
                    "action": {
                        "type": "callback",
                        "payload": json.dumps({"cb": btn["callback_data"]}, ensure_ascii=False),
                        "label": label,
                    },
                    "color": "primary",
                })
            else:
                vk_row.append({"action": {"type": "text", "label": label}})
        if vk_row:
            vk_rows.append(vk_row)
    return {"inline": True, "buttons": vk_rows}


async def get_user_info(vk_id: int, fields: Iterable[str] = ("first_name", "last_name", "screen_name")) -> dict[str, Any] | None:
    """Получить базовую инфу о пользователе VK по id."""
    try:
        resp = await vk_call("users.get", {"user_ids": vk_id, "fields": ",".join(fields)})
        if isinstance(resp, list) and resp:
            return resp[0]
    except RuntimeError as e:
        logger.warning(f"VK get_user_info failed for {vk_id}: {e}")
    return None


async def is_user_member_of_group(group_id: int, vk_id: int, *, token: str | None = None) -> bool | None:
    """Проверить подписан ли пользователь на сообщество. Аналог Telegram getChatMember."""
    try:
        resp = await vk_call("groups.isMember", {"group_id": group_id, "user_id": vk_id}, token=token)
        # resp = 1 / 0
        return bool(resp) if resp is not None else None
    except RuntimeError as e:
        logger.warning(f"VK isMember failed for group={group_id} user={vk_id}: {e}")
        return None
