"""
Форма связки контакта с ПЛЮСОН-аккаунтом — pluson.ru/link-pluson?token=…

Публичные эндпоинты (без auth — личность гарантирует подписанный токен из бота).
Ввод email/пароля идёт на pluson.ru (Beget, РФ-сервер) — обработка ПД законна,
с согласием на форме. В боте/мессенджере данные НЕ вводятся.

См. services/pluson_connect_token.py — как рождается токен (команда /pluson_connect).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import asyncpg

from app.database import get_db
from app.services.pluson_connect_token import parse_pluson_connect_token
from app.services.share_links import TG_DOMAIN

router = APIRouter(prefix="/pluson-connect", tags=["Связка ПЛЮСОН"])


async def _contact_from_token(db, token: str):
    """По токену → (contact_id, client_id, platform). Контакт ищется СТРОГО по
    (client_id, platform, user_id) из токена — не из URL. None если не найден."""
    data = parse_pluson_connect_token(token or "")
    if not data:
        return None
    row = await db.fetchrow(
        """SELECT c.id
             FROM contacts c
             JOIN platform_users pu ON pu.contact_id = c.id
            WHERE c.client_id = $1 AND c.merged_into IS NULL
              AND pu.platform_slug = $2 AND pu.platform_user_id = $3
            LIMIT 1""",
        data["client_id"], data["platform"], data["user_id"],
    )
    if not row:
        return None
    return {"contact_id": row["id"], "client_id": data["client_id"],
            "platform": data["platform"], "user_id": data["user_id"]}


@router.get("/info", summary="Инфо по токену для формы связки")
async def connect_info(token: str, db: asyncpg.Connection = Depends(get_db)):
    ctx = await _contact_from_token(db, token)
    if not ctx:
        raise HTTPException(status_code=400, detail="Ссылка недействительна или устарела")
    row = await db.fetchrow(
        """SELECT c.name, cl.email AS linked_email
             FROM contacts c
             LEFT JOIN clients cl ON cl.id = c.linked_client_id
            WHERE c.id = $1""",
        ctx["contact_id"],
    )
    return {
        "valid": True,
        "contact_name": (row["name"] if row else "") or "",
        "already_linked_email": row["linked_email"] if row else None,
    }


class ConnectIn(BaseModel):
    token: str
    email: str
    password: str
    consent_pd: bool = False   # согласие на обработку ПД (галочка на форме)


async def _bot_return_deeplink(db, client_id: int, platform: str) -> str:
    """Ссылка возврата в бот той площадки с подтверждением привязки."""
    from app.services.share_links import get_client_bot_handles
    handles = await get_client_bot_handles(db, client_id)
    if platform == "telegram" and handles.get("telegram"):
        return f"https://{TG_DOMAIN}/{handles['telegram'].lstrip('@')}?start=pluson_connected"
    if platform == "max" and handles.get("max"):
        return f"https://max.ru/{handles['max'].lstrip('@')}?start=pluson_connected"
    if platform == "vk" and handles.get("vk"):
        return f"https://vk.me/{handles['vk'].lstrip('@')}"
    return ""


@router.post("/link", summary="Связать существующий ПЛЮСОН-аккаунт")
async def connect_link(data: ConnectIn, db: asyncpg.Connection = Depends(get_db)):
    if not data.consent_pd:
        raise HTTPException(status_code=422, detail="Нужно согласие на обработку персональных данных")
    ctx = await _contact_from_token(db, data.token)
    if not ctx:
        raise HTTPException(status_code=400, detail="Ссылка недействительна или устарела")
    from app.auth import verify_password
    email = (data.email or "").strip().lower()
    client = await db.fetchrow(
        "SELECT id, email, password_hash, is_active FROM clients WHERE LOWER(email) = $1",
        email,
    )
    if not client or not verify_password(data.password, client["password_hash"]):
        raise HTTPException(status_code=401, detail="Неверный email или пароль ПЛЮСОН")
    if not client["is_active"]:
        raise HTTPException(status_code=403, detail="Этот ПЛЮСОН-аккаунт заблокирован")
    await db.execute(
        "UPDATE contacts SET linked_client_id = $2 WHERE id = $1",
        ctx["contact_id"], client["id"],
    )
    return {
        "ok": True,
        "linked_client_email": client["email"],
        "return_url": await _bot_return_deeplink(db, ctx["client_id"], ctx["platform"]),
    }


@router.post("/register", summary="Зарегистрировать новый ПЛЮСОН и связать")
async def connect_register(data: ConnectIn, db: asyncpg.Connection = Depends(get_db)):
    if not data.consent_pd:
        raise HTTPException(status_code=422, detail="Нужно согласие на обработку персональных данных")
    ctx = await _contact_from_token(db, data.token)
    if not ctx:
        raise HTTPException(status_code=400, detail="Ссылка недействительна или устарела")
    from app.api.auth import register as auth_register, RegisterRequest
    email = (data.email or "").strip().lower()
    exists = await db.fetchval("SELECT 1 FROM clients WHERE LOWER(email) = $1", email)
    if exists:
        raise HTTPException(status_code=409, detail="Этот email уже зарегистрирован — войдите вместо регистрации")
    ct = await db.fetchrow("SELECT name FROM contacts WHERE id = $1", ctx["contact_id"])
    name = (ct["name"] if ct else None) or "Участник"
    res = await auth_register(RegisterRequest(name=name, email=email, password=data.password), db)
    new_client_id = res["client"]["id"] if isinstance(res, dict) and res.get("client") else None
    if not new_client_id:
        raise HTTPException(status_code=500, detail="Не удалось создать ПЛЮСОН-аккаунт")
    await db.execute(
        "UPDATE contacts SET linked_client_id = $2 WHERE id = $1",
        ctx["contact_id"], new_client_id,
    )
    return {
        "ok": True,
        "linked_client_email": email,
        "return_url": await _bot_return_deeplink(db, ctx["client_id"], ctx["platform"]),
    }
