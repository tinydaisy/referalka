"""CRUD для гейта по подписке в Telegram-чатах клиента (миграция 115).

Клиент включает в своих TG-чатах правило: участник может писать только если
подписан на ВСЕ TG-каналы основателя (массив clients.social_links->'telegram_channels').
Этот файл — REST-API для управления гейтами в дашборде клиента.

Обработка сообщений в чате — в backend/bot/handlers/chat_gate.py.

Связанные миграции:
  - 114: clients.social_links.telegram_channels — массив каналов основателя
  - 115: client_chat_gates — этот файл
"""
from __future__ import annotations

import json
import logging
from typing import Optional

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_client
from app.config import settings
from app.database import get_db
from app.services.channels import get_client_telegram_token
from app.services.social_links import get_founder_tg_channels, telegram_api_id

log = logging.getLogger(__name__)

router = APIRouter(prefix="/clients/me/chat-gates", tags=["Гейт по подписке в чатах"])


# ───────────────────── helpers ─────────────────────

async def _bot_token_for_client(client_id: int, db) -> Optional[str]:
    """Какой бот проверяет подписку — ТОЛЬКО свой бот клиента (системный @pluson_bot
    больше не используется как fallback; он только для самого ПЛЮСОНа)."""
    return await get_client_telegram_token(client_id, db)


def _normalize_chat_id(raw: str) -> str:
    """Чистит ввод chat_id — оставляет только цифры с одним минусом в начале."""
    if not raw:
        return ""
    s = raw.strip()
    sign = "-" if s.startswith("-") else ""
    digits = "".join(c for c in s if c.isdigit())
    return sign + digits if digits else ""


async def _parse_jsonb(value) -> dict:
    if not value:
        return {}
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return {}
    if isinstance(value, dict):
        return value
    return {}


# ───────────────────── pydantic models ─────────────────────

class GateIn(BaseModel):
    chat_id:         str
    chat_title:      Optional[str] = None
    warning_text:    Optional[str] = None
    warning_ttl_sec: Optional[int] = 15
    is_active:       Optional[bool] = False


class GatePatch(BaseModel):
    chat_id:         Optional[str] = None
    chat_title:      Optional[str] = None
    warning_text:    Optional[str] = None
    warning_ttl_sec: Optional[int] = None
    is_active:       Optional[bool] = None


# ───────────────────── CRUD ─────────────────────

@router.get("", summary="Список гейтов клиента")
async def list_gates(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    rows = await db.fetch(
        """SELECT id, chat_id, chat_title, warning_text, warning_ttl_sec,
                  is_active, last_error, last_error_at, last_check_at,
                  created_at, updated_at
             FROM client_chat_gates
            WHERE client_id = $1
         ORDER BY id DESC""",
        int(client["sub"]),
    )
    return {"items": [dict(r) for r in rows]}


@router.post("", summary="Создать гейт")
async def create_gate(
    data: GateIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    chat_id = _normalize_chat_id(data.chat_id)
    if not chat_id or not chat_id.lstrip("-").isdigit():
        raise HTTPException(status_code=400, detail="Введите числовой chat_id (например, -1001234567890)")
    if data.warning_ttl_sec is not None and not (5 <= int(data.warning_ttl_sec) <= 600):
        raise HTTPException(status_code=400, detail="TTL должен быть между 5 и 600 секундами")

    # При создании is_active игнорируем — гейт включается только после успешной verify.
    try:
        row = await db.fetchrow(
            """INSERT INTO client_chat_gates
                 (client_id, chat_id, chat_title, warning_text, warning_ttl_sec, is_active)
               VALUES ($1, $2, $3, $4, $5, FALSE)
               RETURNING id, chat_id, chat_title, warning_text, warning_ttl_sec,
                         is_active, last_error, last_error_at, last_check_at,
                         created_at, updated_at""",
            int(client["sub"]),
            chat_id,
            (data.chat_title or None),
            (data.warning_text or None),
            int(data.warning_ttl_sec or 15),
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Этот чат уже подключён к гейту (возможно, у другого клиента)")
    return dict(row)


@router.patch("/{gate_id}", summary="Обновить гейт")
async def update_gate(
    gate_id: int,
    data: GatePatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    sets = []
    args = []
    if data.chat_id is not None:
        cid = _normalize_chat_id(data.chat_id)
        if not cid or not cid.lstrip("-").isdigit():
            raise HTTPException(status_code=400, detail="Введите числовой chat_id (например, -1001234567890)")
        args.append(cid)
        sets.append(f"chat_id = ${len(args)}")
    if data.chat_title is not None:
        args.append(data.chat_title or None)
        sets.append(f"chat_title = ${len(args)}")
    if data.warning_text is not None:
        args.append(data.warning_text or None)
        sets.append(f"warning_text = ${len(args)}")
    if data.warning_ttl_sec is not None:
        if not (5 <= int(data.warning_ttl_sec) <= 600):
            raise HTTPException(status_code=400, detail="TTL должен быть между 5 и 600 секундами")
        args.append(int(data.warning_ttl_sec))
        sets.append(f"warning_ttl_sec = ${len(args)}")
    if data.is_active is not None:
        # Если клиент включает гейт — требуем чтобы у него были TG-каналы основателя.
        # Иначе включение бессмысленно.
        if data.is_active:
            social = await db.fetchval("SELECT social_links FROM clients WHERE id = $1", int(client["sub"]))
            channels = get_founder_tg_channels(await _parse_jsonb(social))
            if not channels:
                raise HTTPException(
                    status_code=400,
                    detail="Сначала добавьте хотя бы один TG-канал основателя на вкладке «Основатель»",
                )
        args.append(bool(data.is_active))
        sets.append(f"is_active = ${len(args)}")
        if data.is_active:
            # При ручном включении гасим last_error
            sets.append("last_error = NULL")
            sets.append("last_error_at = NULL")
    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")
    sets.append("updated_at = NOW()")
    args.append(gate_id)
    args.append(int(client["sub"]))
    try:
        row = await db.fetchrow(
            f"""UPDATE client_chat_gates SET {', '.join(sets)}
                  WHERE id = ${len(args)-1} AND client_id = ${len(args)}
                  RETURNING id, chat_id, chat_title, warning_text, warning_ttl_sec,
                            is_active, last_error, last_error_at, last_check_at,
                            created_at, updated_at""",
            *args,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=409, detail="Этот chat_id уже занят другим гейтом")
    if not row:
        raise HTTPException(status_code=404, detail="Гейт не найден")
    return dict(row)


@router.delete("/{gate_id}", summary="Удалить гейт")
async def delete_gate(
    gate_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    deleted = await db.fetchval(
        "DELETE FROM client_chat_gates WHERE id = $1 AND client_id = $2 RETURNING id",
        gate_id, int(client["sub"]),
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Гейт не найден")
    return {"ok": True}


# ───────────────────── verify ─────────────────────

async def _tg_call(token: str, method: str, params: dict) -> dict:
    """Вспомогательный вызов Bot API. Возвращает целиком JSON-ответ (без проброса ошибок)."""
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            r = await http.get(
                f"https://api.telegram.org/bot{token}/{method}",
                params=params,
            )
            return r.json()
    except Exception as e:
        return {"ok": False, "description": f"network_error: {e}"}


@router.post("/{gate_id}/verify", summary="Самопроверка: бот в чате + бот во всех каналах основателя")
async def verify_gate(
    gate_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    gate = await db.fetchrow(
        "SELECT id, chat_id FROM client_chat_gates WHERE id = $1 AND client_id = $2",
        gate_id, client_id,
    )
    if not gate:
        raise HTTPException(status_code=404, detail="Гейт не найден")

    token = await _bot_token_for_client(client_id, db)
    if not token:
        raise HTTPException(status_code=400, detail="У клиента не настроен бот для проверки")

    # 1) Узнаём id и username нашего бота — потом будем проверять, админ ли он в чате/каналах.
    me_resp = await _tg_call(token, "getMe", {})
    if not me_resp.get("ok"):
        raise HTTPException(status_code=502, detail=f"Bot API getMe failed: {me_resp.get('description')}")
    bot_id = me_resp["result"]["id"]
    bot_username = me_resp["result"].get("username") or ""

    # 2) Проверка: бот в чате (admin с правом удалять сообщения).
    bot_in_chat = False
    bot_in_chat_can_delete = False
    chat_check_error: Optional[str] = None
    member_resp = await _tg_call(token, "getChatMember", {"chat_id": gate["chat_id"], "user_id": bot_id})
    if member_resp.get("ok"):
        result = member_resp["result"]
        status = result.get("status", "")
        if status == "administrator":
            bot_in_chat = True
            bot_in_chat_can_delete = bool(result.get("can_delete_messages"))
        elif status == "creator":
            bot_in_chat = True
            bot_in_chat_can_delete = True
    else:
        chat_check_error = member_resp.get("description") or "unknown"

    # 3) Проверка: бот админ в КАЖДОМ канале основателя.
    social = await db.fetchval("SELECT social_links FROM clients WHERE id = $1", client_id)
    channels = get_founder_tg_channels(await _parse_jsonb(social))

    async def _check_channel(ch: dict) -> dict:
        target = (ch.get("chat_id") or "").strip() or telegram_api_id(ch.get("url") or "")
        if not target:
            return {
                **ch,
                "bot_in_channel": False,
                "error": "invite_only_no_chat_id",
            }
        resp = await _tg_call(token, "getChatMember", {"chat_id": target, "user_id": bot_id})
        if resp.get("ok"):
            status = resp["result"].get("status", "")
            ok = status in ("administrator", "creator", "member")
            return {**ch, "bot_in_channel": ok, "error": None if ok else "not_admin"}
        desc = (resp.get("description") or "").lower()
        err = "bot_not_in_channel"
        if "chat not found" in desc:
            err = "chat_not_found"
        return {**ch, "bot_in_channel": False, "error": err}

    import asyncio
    channel_results: list[dict] = []
    if channels:
        channel_results = list(await asyncio.gather(*[_check_channel(ch) for ch in channels]))

    all_channels_ok = all(c["bot_in_channel"] for c in channel_results) if channel_results else False
    ready = bool(bot_in_chat and channel_results and all_channels_ok)

    await db.execute(
        "UPDATE client_chat_gates SET last_check_at = NOW() WHERE id = $1",
        gate_id,
    )

    return {
        "bot_username": bot_username,
        "bot_in_chat": bot_in_chat,
        "bot_in_chat_can_delete": bot_in_chat_can_delete,
        "chat_check_error": chat_check_error,
        "channels": channel_results,
        "no_channels": not channels,
        "ready": ready,
    }


@router.get("/founder-channels-status", summary="Бот-админ во ВСЕХ каналах основателя (для гейта лид-магнитов)")
async def founder_channels_status(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Готов ли клиент выдавать лид-магниты: бот подключён и он админ в КАЖДОМ
    Telegram-канале основателя (social_links.telegram_channels).

    Воронка выдачи проверяет подписку на эти каналы через getChatMember — а он
    работает, только если бот админ канала. Если бот не админ, лид-магнит просто
    не отдаётся (частая причина «почему материал не приходит»). Фронт по `ready`
    гейтит ссылки: не готов → показывает их размыто и объясняет что настроить.

    Возвращает {has_bot, no_channels, channels:[{name,url,bot_in_channel,error}], ready}.
    ready=TRUE — есть бот И есть каналы И бот админ во всех.
    """
    import asyncio
    client_id = int(client["sub"])

    token = await _bot_token_for_client(client_id, db)
    if not token:
        return {"has_bot": False, "no_channels": False, "channels": [], "ready": False}

    me = await _tg_call(token, "getMe", {})
    bot_id = (me.get("result") or {}).get("id") if me.get("ok") else None
    if not bot_id:
        return {"has_bot": False, "no_channels": False, "channels": [], "ready": False}

    social = await db.fetchval("SELECT social_links FROM clients WHERE id = $1", client_id)
    channels = get_founder_tg_channels(await _parse_jsonb(social))
    if not channels:
        return {"has_bot": True, "no_channels": True, "channels": [], "ready": False}

    async def _check(ch: dict) -> dict:
        target = (ch.get("chat_id") or "").strip() or telegram_api_id(ch.get("url") or "")
        if not target:
            return {**ch, "bot_in_channel": False, "error": "invite_only_no_chat_id"}
        resp = await _tg_call(token, "getChatMember", {"chat_id": target, "user_id": bot_id})
        if resp.get("ok"):
            ok = resp["result"].get("status", "") in ("administrator", "creator", "member")
            return {**ch, "bot_in_channel": ok, "error": None if ok else "not_admin"}
        desc = (resp.get("description") or "").lower()
        return {**ch, "bot_in_channel": False,
                "error": "chat_not_found" if "chat not found" in desc else "bot_not_in_channel"}

    results = list(await asyncio.gather(*[_check(ch) for ch in channels]))
    ready = all(c["bot_in_channel"] for c in results)
    return {"has_bot": True, "no_channels": False, "channels": results, "ready": ready}
