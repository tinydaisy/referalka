"""
Клиент MAX Bot API для отправки сообщений и работы с ботом ПЛЮСОНа в MAX.

Аналог vk_api.py / bot/main.py (Telegram), но через HTTPS-вызовы MAX Bot API.

Особенности MAX API (отличия от документации dev.max.ru):
- Авторизация — заголовок `Authorization: <token>` БЕЗ префикса Bearer.
- `chat_id` для приватного диалога с пользователем = его user_id.
- В большинстве POST методов chat_id идёт **query-параметром**, а тело — JSON.
- Параллельно работают оба домена: botapi.max.ru и platform-api.max.ru
  (одинаковый ответ). Используем botapi.max.ru (более стабильный, проверен
  в lever_agent).

Документация: https://dev.max.ru/docs-api
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import httpx

from ..config import settings

logger = logging.getLogger(__name__)


def _api_base() -> str:
    return (settings.max_api_base or "https://botapi.max.ru").rstrip("/")


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": token}


async def max_call(
    method: str,
    path: str,
    *,
    token: str,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    """Низкоуровневый вызов MAX Bot API.

    :raises RuntimeError: если MAX вернул поле `code` (ошибка).
    """
    if not token:
        raise RuntimeError("MAX bot token is empty")
    url = f"{_api_base()}{path}"
    async with httpx.AsyncClient(timeout=timeout) as cli:
        resp = await cli.request(
            method,
            url,
            params=params or None,
            json=json_body,
            headers=_auth_headers(token),
        )
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(f"MAX {method} {path} non-JSON response: {resp.status_code} {resp.text[:200]}")
    # MAX отдаёт ошибки с HTTP 200 + телом {"code": "...", "message": "..."}
    # (напр. "chat.not.found"). Поле "ok" в ответе MAX отсутствует, поэтому
    # любое присутствие "code" трактуем как ошибку.
    if isinstance(data, dict) and data.get("code"):
        raise RuntimeError(f"MAX {method} {path} error {data.get('code')}: {data.get('message')}")
    return data


async def get_me(token: str) -> dict[str, Any]:
    """Информация о боте — используется для верификации токена при подключении."""
    return await max_call("GET", "/me", token=token)


def _build_inline_keyboard_attachment(buttons: list[list[dict]]) -> dict:
    """Формат MAX inline-кнопок:
    {"type": "inline_keyboard", "payload": {"buttons": [[{type, text, ...}]]}}
    """
    return {
        "type": "inline_keyboard",
        "payload": {"buttons": buttons},
    }


async def send_message(
    chat_id: int,
    text: str,
    *,
    token: str,
    buttons: list[list[dict]] | None = None,
    attachments: list[dict] | None = None,
    parse_mode: str | None = None,
    recipient_kind: str = "chat",
) -> dict[str, Any] | None:
    """Отправить сообщение пользователю или в чат.

    :param chat_id: получатель. По умолчанию (recipient_kind='user') трактуется
        как user_id пользователя для приватного диалога. Если это id беседы/чата
        (приходит в апдейте вебхука как recipient.chat_id) — передать
        recipient_kind='chat'.
    :param recipient_kind: 'user' → шлём через ?user_id=, 'chat' → через ?chat_id=.
        ВАЖНО: MAX для приватки требует user_id; при chat_id=<user_id> он отвечает
        200 + {"code":"chat.not.found"} и молча НЕ доставляет.
    :param buttons: матрица MAX-кнопок (см. tg_inline_to_max_keyboard).
    :param attachments: список вложений (видео/фото — см. upload_media + max_attachment).
    :param parse_mode: 'markdown' | 'html' | None.
    :return: ответ MAX API (содержит message) или None при ошибке.
    """
    if not text and not attachments:
        raise ValueError("send_message: empty text and no attachments")
    payload: dict[str, Any] = {"text": (text or "")[:4000]}
    if parse_mode:
        payload["format"] = parse_mode
    combined_attachments: list[dict] = list(attachments or [])
    if buttons:
        combined_attachments.append(_build_inline_keyboard_attachment(buttons))
    if combined_attachments:
        payload["attachments"] = combined_attachments
    try:
        # Для приватного диалога MAX ожидает user_id получателя, НЕ chat_id.
        # При chat_id=<user_id> MAX отвечает 200 + {"code":"chat.not.found"} и
        # сообщение молча не доставляется. Для ответа в реальную беседу (id чата
        # из апдейта вебхука) используем chat_id — recipient_kind='chat'.
        send_param = {"chat_id": chat_id} if recipient_kind == "chat" else {"user_id": chat_id}
        return await max_call(
            "POST", "/messages",
            token=token,
            params=send_param,
            json_body=payload,
        )
    except RuntimeError as e:
        logger.warning(f"MAX send_message failed chat_id={chat_id}: {e}")
        return None


async def upload_media(file_path: str | Path, *, token: str, kind: str = "image") -> dict | None:
    """Двухшаговая загрузка медиа в MAX.

    1. POST /uploads?type=image|video → возвращает {url, token}.
    2. POST на url multipart с файлом.

    :param kind: 'image' | 'video' | 'audio' | 'file'.
    :return: attachment-dict для вставки в send_message.attachments
             ({"type": "image"/"video", "payload": {"token": "..."}})
    """
    path = Path(file_path)
    if not path.exists():
        logger.warning(f"MAX upload: file not found {path}")
        return None
    try:
        step1 = await max_call(
            "POST", "/uploads",
            token=token,
            params={"type": kind},
        )
    except RuntimeError as e:
        logger.warning(f"MAX upload step1 failed: {e}")
        return None
    upload_url = step1.get("url")
    media_token = step1.get("token")
    if not upload_url or not media_token:
        logger.warning(f"MAX upload step1 returned no url/token: {step1}")
        return None
    try:
        async with httpx.AsyncClient(timeout=180.0) as cli:
            with open(path, "rb") as f:
                files = {"file": (path.name, f, _guess_content_type(path, kind))}
                resp = await cli.post(upload_url, files=files)
        if resp.status_code != 200:
            logger.warning(f"MAX upload step2 status={resp.status_code} body={resp.text[:200]}")
            return None
    except Exception as e:
        logger.warning(f"MAX upload step2 error: {e}")
        return None
    return {"type": kind if kind != "image" else "image", "payload": {"token": media_token}}


def _guess_content_type(path: Path, kind: str) -> str:
    ext = path.suffix.lower()
    if kind == "video":
        return {".mp4": "video/mp4", ".mov": "video/quicktime"}.get(ext, "video/mp4")
    if kind == "image":
        return {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(ext, "image/jpeg")
    if kind == "audio":
        return {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4"}.get(ext, "audio/mpeg")
    return "application/octet-stream"


def tg_inline_to_max_keyboard(buttons: list[list[dict]]) -> list[list[dict]]:
    """Конвертер Telegram inline-кнопок в MAX-формат.

    Telegram:
      [[{"text": "X", "url": "https://..."}],
       [{"text": "Y", "callback_data": "..."}]]

    MAX (внутри inline_keyboard.payload.buttons):
      [[{"type": "link", "text": "X", "url": "https://..."}],
       [{"type": "callback", "text": "Y", "payload": "..."}]]
    """
    out: list[list[dict]] = []
    for row in buttons:
        max_row: list[dict] = []
        for btn in row:
            label = btn.get("text", "")
            if "url" in btn:
                max_row.append({"type": "link", "text": label, "url": btn["url"]})
            elif "callback_data" in btn:
                max_row.append({"type": "callback", "text": label, "payload": btn["callback_data"]})
            elif "web_app" in btn:
                max_row.append({"type": "open_app", "text": label, "url": btn["web_app"].get("url", "")})
            else:
                max_row.append({"type": "callback", "text": label, "payload": label})
        if max_row:
            out.append(max_row)
    return out


async def set_webhook(webhook_url: str, *, token: str) -> dict[str, Any]:
    """Зарегистрировать webhook URL для бота. Используется при подключении бота
    клиента (POST /channels/connect-max-bot) и для системного бота на проде.
    """
    return await max_call(
        "POST", "/subscriptions",
        token=token,
        json_body={"url": webhook_url},
    )


async def delete_webhook(webhook_url: str, *, token: str) -> dict[str, Any]:
    """Снять webhook (например, при переключении dev↔prod)."""
    return await max_call(
        "DELETE", "/subscriptions",
        token=token,
        params={"url": webhook_url},
    )


async def get_updates(*, token: str, marker: int | None = None, timeout: int = 5) -> dict[str, Any]:
    """Long-polling для dev (когда webhook нацелен на прод). Используется
    в backend/bot/max_main.py.
    """
    params: dict[str, Any] = {"timeout": timeout}
    if marker is not None:
        params["marker"] = marker
    return await max_call("GET", "/updates", token=token, params=params)
