"""
Клиент WhatsApp-моста ПЛЮСОНа.

WhatsApp (в отличие от TG/VK/MAX) не даёт бота с токеном — сообщения шлёт
залогиненный через WhatsApp Web клиент (headless Chromium). Поэтому есть
отдельный Node-сервис (wa-bridge/, whatsapp-web.js), который держит по одной
сессии на client_id. Здесь — тонкая HTTP-обёртка над ним.

Мост слушает 127.0.0.1 и требует заголовок X-Bridge-Token (общий секрет).

state сессии: none | starting | qr | authenticated | ready | auth_failure | disconnected.
Для отправки/чтения годятся и 'ready', и 'authenticated'.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

USABLE_STATES = ("ready", "authenticated")


def _base() -> str:
    return (settings.wa_bridge_url or "http://127.0.0.1:8790").rstrip("/")


def _headers() -> dict[str, str]:
    return {"X-Bridge-Token": settings.wa_bridge_token or ""}


async def _call(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any] | list[Any]:
    url = f"{_base()}{path}"
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.request(method, url, json=json_body, headers=_headers())
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(f"WA-bridge {method} {path}: не-JSON ответ {resp.status_code} {resp.text[:200]}")
    if resp.status_code >= 400:
        msg = data.get("error") if isinstance(data, dict) else data
        raise RuntimeError(f"WA-bridge {method} {path} error {resp.status_code}: {msg}")
    return data


async def is_alive() -> bool:
    """Жив ли мост (health-check, без токена)."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as cli:
            r = await cli.get(f"{_base()}/health")
        return r.status_code == 200
    except Exception:
        return False


async def start_session(client_id: int) -> dict[str, Any]:
    """Инициализировать сессию клиента (начинает логин, порождает QR)."""
    return await _call("POST", f"/sessions/{client_id}/start")  # type: ignore[return-value]


async def get_status(client_id: int) -> str:
    data = await _call("GET", f"/sessions/{client_id}/status")
    return data.get("state", "none") if isinstance(data, dict) else "none"


async def get_qr(client_id: int) -> dict[str, Any]:
    """{ state, qr } — qr это data:image PNG пока state=qr, иначе None."""
    return await _call("GET", f"/sessions/{client_id}/qr")  # type: ignore[return-value]


async def list_chats(client_id: int) -> list[dict[str, Any]]:
    """Список чатов аккаунта: [{ id, name, isGroup, unread }]."""
    data = await _call("GET", f"/sessions/{client_id}/chats", timeout=40.0)
    return data if isinstance(data, list) else []


async def send_message(client_id: int, chat_id: str, text: str) -> dict[str, Any]:
    """Отправить текст в чат (chat_id вида <номер>@c.us или <...>@g.us)."""
    return await _call(  # type: ignore[return-value]
        "POST", f"/sessions/{client_id}/send",
        json_body={"chatId": chat_id, "text": text},
        timeout=40.0,
    )


async def logout(client_id: int) -> dict[str, Any]:
    """Разлогинить аккаунт и стереть сессию на мосту."""
    return await _call("POST", f"/sessions/{client_id}/logout")  # type: ignore[return-value]
