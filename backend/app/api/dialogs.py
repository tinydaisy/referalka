"""API личных переписок (Диалоги) — клиент видит историю ЛС и отвечает людям.

Все эндпоинты под /api/v1 и требуют JWT клиента (get_current_client).
Источник данных — таблица direct_messages (миграция 160).

Отправка/правка/удаление ответов идёт через бот клиента на нужной платформе:
  • Telegram — Bot API sendMessage / editMessageText / deleteMessage;
  • VK       — messages.send / messages.edit / messages.delete (community token);
  • MAX      — POST/PUT/DELETE /messages (bot token).

Токен платформы берём из channels.bot_token соответствующего канала клиента.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import get_current_client
from app.database import get_db
from app.services.dialog_archive import archive_direct_message
from app.services.assistant_access import assistant_is_restricted

log = logging.getLogger(__name__)
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# Резолв токена и собеседника
# ─────────────────────────────────────────────────────────────────────────────

async def _resolve_channel_token(db, client_id: int, platform: str,
                                 channel_id: Optional[int]) -> tuple[Optional[int], Optional[str]]:
    """(channel_id, bot_token) канала клиента на платформе для отправки ответа.

    Если channel_id задан — берём его (с проверкой принадлежности клиенту).
    Иначе — главный канал клиента на платформе.
    """
    if channel_id:
        row = await db.fetchrow(
            """SELECT ch.id, ch.bot_token FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1 AND ch.id = $2 AND ch.platform_slug = $3
                LIMIT 1""",
            client_id, channel_id, platform,
        )
    else:
        row = await db.fetchrow(
            """SELECT ch.id, ch.bot_token FROM channels ch
                 JOIN client_channels cc ON cc.channel_id = ch.id
                WHERE cc.client_id = $1 AND ch.platform_slug = $2
                ORDER BY cc.is_active DESC, cc.id ASC LIMIT 1""",
            client_id, platform,
        )
    if not row:
        return None, None
    return int(row["id"]), row["bot_token"]


# ─────────────────────────────────────────────────────────────────────────────
# Платформенная отправка / правка / удаление
# ─────────────────────────────────────────────────────────────────────────────

async def _tg_send(token: str, chat_id: str, text: str) -> tuple[Optional[str], Optional[str]]:
    """→ (message_id, error). chat_id = tg_id собеседника."""
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
            )
        data = r.json()
        if data.get("ok"):
            return str(data["result"]["message_id"]), None
        return None, data.get("description") or "Telegram отклонил отправку"
    except Exception as e:  # noqa: BLE001
        return None, str(e)


async def _tg_edit(token: str, chat_id: str, message_id: str, text: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/editMessageText",
                json={"chat_id": chat_id, "message_id": int(message_id), "text": text},
            )
        data = r.json()
        return None if data.get("ok") else (data.get("description") or "не удалось изменить")
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _tg_delete(token: str, chat_id: str, message_id: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post(
                f"https://api.telegram.org/bot{token}/deleteMessage",
                json={"chat_id": chat_id, "message_id": int(message_id)},
            )
        data = r.json()
        return None if data.get("ok") else (data.get("description") or "не удалось удалить")
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _vk_send(token: str, user_id: str, text: str) -> tuple[Optional[str], Optional[str]]:
    from app.services.vk_api import send_message as vk_send
    res = await vk_send(int(user_id), text, token=token, return_error=True)
    mid, code, msg = res if isinstance(res, tuple) else (res, None, "")
    if mid:
        return str(mid), None
    try:
        from app.tasks.broadcast import _vk_error_human  # человекочитаемая причина
        human = _vk_error_human(code, msg or "")
    except Exception:  # noqa: BLE001
        human = msg or "VK отклонил отправку"
    return None, human


async def _vk_edit(token: str, user_id: str, message_id: str, text: str) -> Optional[str]:
    from app.services.vk_api import vk_call
    try:
        await vk_call("messages.edit", {
            "peer_id": int(user_id), "message_id": int(message_id),
            "message": text, "keep_forward_messages": 1, "keep_snippets": 1,
        }, token=token)
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _vk_delete(token: str, user_id: str, message_id: str) -> Optional[str]:
    from app.services.vk_api import vk_call
    try:
        await vk_call("messages.delete", {
            "message_ids": int(message_id), "delete_for_all": 1,
        }, token=token)
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _max_send(token: str, user_id: str, text: str) -> tuple[Optional[str], Optional[str]]:
    from app.services.max_api import send_message as max_send
    try:
        resp = await max_send(int(user_id), text, token=token, recipient_kind="user")
        mid = None
        if isinstance(resp, dict):
            mid = ((resp.get("message") or {}).get("body") or {}).get("mid")
        return (str(mid) if mid else None), (None if mid else "MAX не подтвердил доставку")
    except Exception as e:  # noqa: BLE001
        return None, str(e)


async def _max_edit(token: str, message_id: str, text: str) -> Optional[str]:
    from app.services.max_api import max_call
    try:
        await max_call("PUT", "/messages", token=token,
                       params={"message_id": message_id}, json_body={"text": text})
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


async def _max_delete(token: str, message_id: str) -> Optional[str]:
    from app.services.max_api import max_call
    try:
        await max_call("DELETE", "/messages", token=token,
                       params={"message_id": message_id})
        return None
    except Exception as e:  # noqa: BLE001
        return str(e)


# ─────────────────────────────────────────────────────────────────────────────
# GET список диалогов клиента
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/dialogs")
async def list_dialogs(
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=60, le=200),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Список диалогов: по одному на контакт, с последним сообщением и счётчиком
    непрочитанных. Сортировка — по времени последнего сообщения (свежие сверху)."""
    client_id = int(client["sub"])
    rows = await db.fetch(
        """
        WITH last AS (
            SELECT DISTINCT ON (contact_id, platform)
                   contact_id, platform, text, media_kind, direction, sent_at
              FROM direct_messages
             WHERE client_id = $1 AND contact_id IS NOT NULL
             ORDER BY contact_id, platform, sent_at DESC
        ),
        agg AS (
            SELECT contact_id,
                   MAX(sent_at) AS last_at,
                   array_agg(DISTINCT platform) AS platforms,
                   SUM(CASE WHEN direction='in' AND NOT is_read THEN 1 ELSE 0 END) AS unread
              FROM direct_messages
             WHERE client_id = $1 AND contact_id IS NOT NULL
             GROUP BY contact_id
        )
        SELECT a.contact_id, a.last_at, a.platforms, a.unread,
               c.name, c.ref_code,
               (SELECT text FROM direct_messages dm
                  WHERE dm.client_id=$1 AND dm.contact_id=a.contact_id
                  ORDER BY dm.sent_at DESC LIMIT 1) AS last_text,
               (SELECT media_kind FROM direct_messages dm
                  WHERE dm.client_id=$1 AND dm.contact_id=a.contact_id
                  ORDER BY dm.sent_at DESC LIMIT 1) AS last_media_kind,
               (SELECT direction FROM direct_messages dm
                  WHERE dm.client_id=$1 AND dm.contact_id=a.contact_id
                  ORDER BY dm.sent_at DESC LIMIT 1) AS last_direction
          FROM agg a
          JOIN contacts c ON c.id = a.contact_id
         WHERE ($2::text IS NULL OR c.name ILIKE '%'||$2||'%')
         ORDER BY a.last_at DESC
         LIMIT $3
        """,
        client_id, search, limit,
    )
    return {"dialogs": [dict(r) for r in rows]}


# ─────────────────────────────────────────────────────────────────────────────
# GET лента переписки по контакту
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/contacts/{contact_id}/messages")
async def contact_messages(
    contact_id: int,
    platform: Optional[str] = Query(default=None),
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Полная лента личной переписки с контактом (опц. фильтр по платформе).
    Также помечает входящие прочитанными."""
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT id, platform, channel_id, platform_user_id, direction, author_kind,
                  text, media_url, media_kind, platform_message_id,
                  is_deleted, error, sent_at, edited_at
             FROM direct_messages
            WHERE client_id = $1 AND contact_id = $2
              AND ($3::text IS NULL OR platform = $3)
            ORDER BY sent_at ASC, id ASC""",
        client_id, contact_id, platform,
    )
    # какие платформы вообще есть в переписке (для вкладок TG/VK/MAX)
    plats = await db.fetch(
        "SELECT DISTINCT platform FROM direct_messages WHERE client_id=$1 AND contact_id=$2",
        client_id, contact_id,
    )
    await db.execute(
        """UPDATE direct_messages SET is_read = TRUE
            WHERE client_id=$1 AND contact_id=$2 AND direction='in' AND NOT is_read""",
        client_id, contact_id,
    )
    return {
        "messages": [dict(r) for r in rows],
        "platforms": [r["platform"] for r in plats],
    }


# ─────────────────────────────────────────────────────────────────────────────
# POST ответ от имени клиента
# ─────────────────────────────────────────────────────────────────────────────

class ReplyBody(BaseModel):
    platform: str          # telegram | vk | max
    text: str
    channel_id: Optional[int] = None


@router.post("/contacts/{contact_id}/reply")
async def reply_to_contact(
    contact_id: int,
    body: ReplyBody,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    """Отправить сообщение человеку через бот клиента и записать его в ленту."""
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Ассистент не может отвечать в диалогах.")
    client_id = int(client["sub"])
    platform = body.platform.strip().lower()
    if platform not in ("telegram", "vk", "max"):
        raise HTTPException(400, "Неизвестная платформа")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустое сообщение")

    # platform_user_id собеседника по контакту на этой платформе
    pu = await db.fetchval(
        """SELECT pu.platform_user_id FROM platform_users pu
            JOIN contacts c_own ON c_own.id = pu.contact_id
            WHERE pu.contact_id=$1 AND c_own.client_id=$2 AND pu.platform_slug=$3 LIMIT 1""",
        contact_id, client_id, platform,
    )
    if not pu:
        raise HTTPException(404, "У контакта нет аккаунта на этой платформе")

    channel_id, token = await _resolve_channel_token(db, client_id, platform, body.channel_id)
    if not token:
        raise HTTPException(400, "У вас не подключён бот/сообщество на этой платформе")

    if platform == "telegram":
        mid, err = await _tg_send(token, str(pu), text)
    elif platform == "vk":
        mid, err = await _vk_send(token, str(pu), text)
    else:
        mid, err = await _max_send(token, str(pu), text)

    row_id = await archive_direct_message(
        client_id=client_id, platform=platform, channel_id=channel_id,
        platform_user_id=str(pu), direction="out", author_kind="operator",
        text=text, platform_message_id=mid, contact_id=contact_id, error=err,
    )
    if err:
        # Сообщение записали с пометкой ошибки, но честно сообщаем клиенту.
        raise HTTPException(502, f"Не доставлено: {err}")
    return {"ok": True, "id": row_id, "platform_message_id": mid}


# ─────────────────────────────────────────────────────────────────────────────
# PATCH правка своего сообщения
# ─────────────────────────────────────────────────────────────────────────────

class EditBody(BaseModel):
    text: str


@router.patch("/dialog-messages/{message_id}")
async def edit_message(
    message_id: int,
    body: EditBody,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Ассистент не может править диалоги.")
    client_id = int(client["sub"])
    msg = await db.fetchrow(
        """SELECT platform, platform_user_id, platform_message_id, author_kind
             FROM direct_messages WHERE id=$1 AND client_id=$2""",
        message_id, client_id,
    )
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    if msg["author_kind"] != "operator":
        raise HTTPException(400, "Можно править только свои отправленные сообщения")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустой текст")

    channel_id, token = await _resolve_channel_token(db, client_id, msg["platform"], None)
    err = None
    if token and msg["platform_message_id"]:
        if msg["platform"] == "telegram":
            err = await _tg_edit(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]), text)
        elif msg["platform"] == "vk":
            err = await _vk_edit(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]), text)
        else:
            err = await _max_edit(token, str(msg["platform_message_id"]), text)
    if err:
        raise HTTPException(502, f"Не удалось изменить у получателя: {err}")
    await db.execute(
        "UPDATE direct_messages SET text=$1, edited_at=now() WHERE id=$2",
        text, message_id,
    )
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
# DELETE удаление своего сообщения
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/dialog-messages/{message_id}")
async def delete_message(
    message_id: int,
    client=Depends(get_current_client),
    db=Depends(get_db),
):
    if await assistant_is_restricted(client):
        raise HTTPException(403, "Ассистент не может удалять в диалогах.")
    client_id = int(client["sub"])
    msg = await db.fetchrow(
        """SELECT platform, platform_user_id, platform_message_id, author_kind
             FROM direct_messages WHERE id=$1 AND client_id=$2""",
        message_id, client_id,
    )
    if not msg:
        raise HTTPException(404, "Сообщение не найдено")
    if msg["author_kind"] != "operator":
        raise HTTPException(400, "Можно удалять только свои отправленные сообщения")

    channel_id, token = await _resolve_channel_token(db, client_id, msg["platform"], None)
    if token and msg["platform_message_id"]:
        if msg["platform"] == "telegram":
            await _tg_delete(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]))
        elif msg["platform"] == "vk":
            await _vk_delete(token, str(msg["platform_user_id"]), str(msg["platform_message_id"]))
        else:
            await _max_delete(token, str(msg["platform_message_id"]))
    # В ленте помечаем удалённым (не стираем строку — история остаётся у клиента).
    await db.execute(
        "UPDATE direct_messages SET is_deleted=TRUE, text=NULL WHERE id=$1",
        message_id,
    )
    return {"ok": True}
