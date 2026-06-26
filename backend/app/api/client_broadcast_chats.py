"""
База внешних чатов/групп/каналов клиента для рассылок (миграция 170).

Выносит «доп. чаты для отправки» с уровня события на уровень КЛИЕНТА: единая
база, в которую дополнительно льются рассылки (общие и событийные). Гейт по
фиче `broadcast_chats` (только тариф Экстра 2990 + admin).

Endpoints (/api/v1/clients/me/broadcast-chats):
  GET    /                — список чатов клиента
  POST   /                — добавить чат (после резолва или вручную)
  PATCH  /{id}            — переименовать / активировать
  DELETE /{id}            — удалить
  POST   /resolve         — определить chat_id + название по ссылке (TG/VK), MAX — вручную
"""
from __future__ import annotations

import httpx
import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.auth import get_current_client
from app.config import settings
from app.database import get_db
from app.services.features import client_has_feature
from app.services.social_links import telegram_api_id, vk_screen_name_from_link

router = APIRouter(prefix="/clients/me/broadcast-chats", tags=["Чаты для рассылок"])


# ── Гейт по фиче ──
async def _assert_feature(db, client_id: int) -> None:
    if not await client_has_feature(db, client_id, "broadcast_chats"):
        raise HTTPException(
            status_code=403,
            detail="Чаты для рассылок доступны на тарифе Экстра. Перейдите на него в разделе «Подписка».",
        )


class ChatIn(BaseModel):
    platform: str                       # telegram | vk | max
    chat_id: str
    title: Optional[str] = None
    chat_url: Optional[str] = None
    is_public: Optional[bool] = False
    added_via: Optional[str] = "manual"  # link | manual


class ChatPatch(BaseModel):
    title: Optional[str] = None
    is_active: Optional[bool] = None


class ResolveIn(BaseModel):
    platform: str                       # telegram | vk | max
    url: Optional[str] = None           # ссылка на группу/канал
    username: Optional[str] = None      # @foo / foo


@router.get("/", summary="Список чатов клиента для рассылок")
async def list_chats(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    rows = await db.fetch(
        """SELECT id, platform, chat_id, title, chat_url, is_public, added_via, is_active, created_at
             FROM client_broadcast_chats
            WHERE client_id = $1
            ORDER BY platform, id""",
        client_id,
    )
    return {"chats": [dict(r) for r in rows]}


@router.post("/resolve", summary="Определить chat_id + название по ссылке")
async def resolve_chat(
    data: ResolveIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Публичный TG → getChat (chat_id + title). Публичный VK → resolveScreenName
    (group_id + name). MAX — публичного метода нет, клиент вписывает вручную."""
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    platform = (data.platform or "").lower()

    if platform == "telegram":
        api_id = ""
        if data.username and data.username.strip():
            u = data.username.strip().lstrip("@").split("/")[-1]
            if u:
                api_id = f"@{u}"
        elif data.url and data.url.strip():
            api_id = telegram_api_id(data.url)
        if not api_id:
            raise HTTPException(
                status_code=400,
                detail="У канала нет публичного @username (закрытый по инвайт-ссылке). Введите ID и название вручную.",
            )
        token = settings.telegram_bot_token
        if not token:
            raise HTTPException(status_code=500, detail="Bot token не настроен")
        try:
            async with httpx.AsyncClient(timeout=10) as http:
                r = await http.get(
                    f"https://api.telegram.org/bot{token}/getChat",
                    params={"chat_id": api_id},
                )
                d = r.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Не дозвонились до Telegram: {e}")
        if not d.get("ok"):
            raise HTTPException(status_code=400, detail=f"Telegram отказал: {d.get('description', 'unknown')}")
        res = d["result"]
        cid = res.get("id")
        if not cid:
            raise HTTPException(status_code=502, detail="getChat не вернул id")
        return {"platform": "telegram", "chat_id": str(cid),
                "title": res.get("title") or res.get("username") or "",
                "is_public": True, "added_via": "link"}

    if platform == "vk":
        screen = None
        if data.username and data.username.strip():
            screen = data.username.strip().lstrip("@").split("/")[-1]
        elif data.url and data.url.strip():
            screen = vk_screen_name_from_link(data.url)
        if not screen:
            raise HTTPException(status_code=400, detail="Не удалось разобрать ссылку VK. Введите ID и название вручную.")
        try:
            from app.services.vk_api import vk_call
            resp = await vk_call("utils.resolveScreenName", {"screen_name": screen})
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"VK API недоступен: {e}")
        if not (isinstance(resp, dict) and resp.get("object_id")):
            raise HTTPException(status_code=400, detail="VK не нашёл такое сообщество. Введите ID и название вручную.")
        gid = int(resp["object_id"])
        title = ""
        try:
            from app.services.vk_api import vk_call as _vc
            g = await _vc("groups.getById", {"group_id": gid})
            if isinstance(g, list) and g:
                title = g[0].get("name") or ""
            elif isinstance(g, dict) and g.get("groups"):
                title = g["groups"][0].get("name") or ""
        except Exception:
            pass
        return {"platform": "vk", "chat_id": str(gid), "title": title,
                "is_public": True, "added_via": "link"}

    # MAX — публичного резолва нет
    raise HTTPException(
        status_code=400,
        detail="У MAX нет автоопределения ID. Введите ID чата и название вручную.",
    )


@router.post("/", summary="Добавить чат")
async def add_chat(
    data: ChatIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    platform = (data.platform or "").lower()
    if platform not in ("telegram", "vk", "max"):
        raise HTTPException(status_code=400, detail="platform должен быть telegram | vk | max")
    chat_id = (data.chat_id or "").strip()
    if not chat_id:
        raise HTTPException(status_code=400, detail="Укажите ID чата")
    title = (data.title or "").strip() or None
    try:
        row = await db.fetchrow(
            """INSERT INTO client_broadcast_chats
                   (client_id, platform, chat_id, title, chat_url, is_public, added_via)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (client_id, platform, chat_id)
               DO UPDATE SET title = COALESCE(EXCLUDED.title, client_broadcast_chats.title),
                             chat_url = COALESCE(EXCLUDED.chat_url, client_broadcast_chats.chat_url),
                             is_public = EXCLUDED.is_public,
                             is_active = TRUE,
                             updated_at = now()
               RETURNING id, platform, chat_id, title, chat_url, is_public, added_via, is_active, created_at""",
            client_id, platform, chat_id, title,
            (data.chat_url or "").strip() or None,
            bool(data.is_public), (data.added_via or "manual"),
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Не удалось добавить: {e}")
    return dict(row)


@router.patch("/{chat_id}", summary="Переименовать / активировать чат")
async def patch_chat(
    chat_id: int,
    data: ChatPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    sets, args = [], []
    if data.title is not None:
        args.append(data.title.strip() or None); sets.append(f"title = ${len(args)}")
    if data.is_active is not None:
        args.append(bool(data.is_active)); sets.append(f"is_active = ${len(args)}")
    if not sets:
        raise HTTPException(status_code=400, detail="Нечего обновлять")
    args.extend([chat_id, client_id])
    row = await db.fetchrow(
        f"""UPDATE client_broadcast_chats SET {', '.join(sets)}, updated_at = now()
             WHERE id = ${len(args)-1} AND client_id = ${len(args)}
         RETURNING id, platform, chat_id, title, chat_url, is_public, added_via, is_active, created_at""",
        *args,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Чат не найден")
    return dict(row)


@router.delete("/{chat_id}", summary="Удалить чат")
async def delete_chat(
    chat_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    client_id = int(client["sub"])
    await _assert_feature(db, client_id)
    res = await db.execute(
        "DELETE FROM client_broadcast_chats WHERE id = $1 AND client_id = $2",
        chat_id, client_id,
    )
    if res.endswith("0"):
        raise HTTPException(status_code=404, detail="Чат не найден")
    return {"ok": True}
