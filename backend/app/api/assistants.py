"""
Управление ассистентом клиента — один ассистент на одного клиента.

Ассистент входит на /login через свой email + сгенерированный системой пароль.
В JWT попадает role='assistant' и client_id владельца — ассистент работает
в кабинете этого клиента с урезанным набором прав (см. middleware
assistant_permission_guard.py).

Пароль хранится в открытом виде в `client_assistants.password_plain` ради
иконки-глазика в /dashboard/settings: клиент может посмотреть пароль и
переслать ассистенту повторно. Это сознательный trade-off безопасности.
"""
import secrets
import string
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr

from app.auth import decode_token, hash_password, security
from app.database import get_db

router = APIRouter(prefix="/clients/me/assistant", tags=["Ассистент клиента"])


def _generate_password(length: int = 12) -> str:
    """12 символов, латиница + цифры. Исключены визуально похожие 0/O/o/1/l/I."""
    alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"
    return "".join(secrets.choice(alphabet) for _ in range(length))


async def _require_owner(credentials: HTTPAuthorizationCredentials, db: asyncpg.Connection) -> int:
    """Возвращает client_id владельца кабинета. 403 для ассистента, 401 без токена."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    if payload.get("role") == "assistant":
        raise HTTPException(status_code=403, detail="Ассистент не может управлять ассистентом")
    if payload.get("role") not in ("client", None):
        # admin тоже не управляет ассистентами через этот endpoint
        raise HTTPException(status_code=403, detail="Доступ запрещён")
    return int(payload["sub"])


async def _send_assistant_password_email(
    db: asyncpg.Connection,
    *,
    client_id: int,
    client_brand_name: str,
    to_email: str,
    password: str,
    is_reset: bool,
) -> None:
    """
    Шлёт ассистенту письмо с паролем через системный email-канал ПЛЮСОНа.
    Тихо проглатывает SMTP-ошибки — клиент в UI видит пароль и так.
    """
    try:
        from app.services.email_sender import EmailSender, EmailSendError
        from app.services.unsubscribe_token import make_email_unsubscribe_token
        from app.config import settings as _s

        ch = await db.fetchrow(
            """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                      ch.email_subdomain, ch.email_from_local
                 FROM client_channels cc
                 JOIN channels ch ON ch.id = cc.channel_id
                WHERE cc.client_id = $1
                  AND ch.platform_slug = 'email'
                  AND ch.is_system = TRUE
                LIMIT 1""",
            client_id,
        )
        if not ch:
            return

        login_url = f"{_s.frontend_url.rstrip('/')}/login"
        channel_dict = dict(ch)
        channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"

        # Транзакционное письмо — отписка не нужна, но подвал всё равно вставится.
        fake_unsub = make_email_unsubscribe_token(
            client_id=client_id, contact_id=0,
            client_channel_id=ch["client_channel_id"],
        )

        verb = "обновил" if is_reset else "подключил"
        intro = (
            f"Здравствуйте!\n\n"
            f"Клиент «{client_brand_name}» {verb} вам доступ ассистента в свой кабинет "
            f"в iViSiON: ПЛЮСОН.\n\n"
            f"Адрес кабинета: {login_url}\n"
            f"Логин: {to_email}\n"
            f"Пароль: {password}\n\n"
            f"Вы сможете работать с контактами, событиями, рассылками и реф-программой клиента, "
            f"но не сможете удалять данные и заходить в раздел «Настройки» и «Каналы».\n\n"
            f"Если вы не ожидали этого письма — игнорируйте его, доступ останется неактивным "
            f"до первого входа.\n\n"
            f"— Команда ПЛЮСОН"
        )
        subject = (
            "Обновлён пароль ассистента — iViSiON: ПЛЮСОН"
            if is_reset
            else "Вам выдан доступ ассистента — iViSiON: ПЛЮСОН"
        )

        EmailSender().send(
            channel=channel_dict,
            client_brand_name="iViSiON: ПЛЮСОН",
            to_email=to_email,
            subject=subject,
            body_text=intro,
            unsubscribe_token=fake_unsub,
        )
    except Exception:
        # Намеренно глотаем — клиент в UI видит пароль и сможет передать вручную.
        pass


# ═════════════════════════════════════════════════════════════
# GET — текущий ассистент (без password_plain)
# ═════════════════════════════════════════════════════════════

@router.get("", summary="Получить текущего ассистента клиента")
async def get_assistant(
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    row = await db.fetchrow(
        """SELECT id, email, last_login_at, created_at, updated_at
             FROM client_assistants WHERE client_id = $1""",
        client_id,
    )
    if not row:
        return {"assistant": None}
    return {
        "assistant": {
            "id": row["id"],
            "email": row["email"],
            "last_login_at": row["last_login_at"].isoformat() if row["last_login_at"] else None,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        }
    }


# ═════════════════════════════════════════════════════════════
# GET password — открытый пароль (для иконки-глазика)
# ═════════════════════════════════════════════════════════════

@router.get("/password", summary="Получить открытый пароль ассистента")
async def get_assistant_password(
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    row = await db.fetchrow(
        "SELECT password_plain FROM client_assistants WHERE client_id = $1",
        client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Ассистент не подключён")
    return {"password": row["password_plain"]}


# ═════════════════════════════════════════════════════════════
# POST — создать ассистента
# ═════════════════════════════════════════════════════════════

class CreateAssistantRequest(BaseModel):
    email: EmailStr


@router.post("", summary="Подключить ассистента (генерит пароль и шлёт письмо)")
async def create_assistant(
    data: CreateAssistantRequest,
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)

    email_norm = data.email.strip().lower()

    # У клиента уже есть ассистент?
    existing = await db.fetchrow(
        "SELECT id FROM client_assistants WHERE client_id = $1", client_id
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail="У вас уже подключён ассистент. Сначала отключите текущего.",
        )

    # Email не должен пересекаться с email клиента — иначе при логине бэк
    # не сможет однозначно понять «это владелец или ассистент».
    if await db.fetchval("SELECT 1 FROM clients WHERE LOWER(email) = $1", email_norm):
        raise HTTPException(
            status_code=409,
            detail="Этот email уже используется как email клиента. Выберите другой адрес для ассистента.",
        )

    # Email не должен пересекаться с email админа.
    if await db.fetchval("SELECT 1 FROM admins WHERE LOWER(email) = $1", email_norm):
        raise HTTPException(
            status_code=409,
            detail="Этот email занят. Выберите другой.",
        )

    # Email не должен пересекаться с другим ассистентом.
    if await db.fetchval(
        "SELECT 1 FROM client_assistants WHERE LOWER(email) = $1", email_norm
    ):
        raise HTTPException(
            status_code=409,
            detail="Этот email уже подключён как ассистент у другого клиента.",
        )

    password = _generate_password()
    pw_hash = hash_password(password)

    row = await db.fetchrow(
        """INSERT INTO client_assistants (client_id, email, password_hash, password_plain)
           VALUES ($1, $2, $3, $4)
           RETURNING id, email, created_at, updated_at""",
        client_id, email_norm, pw_hash, password,
    )

    client_row = await db.fetchrow(
        "SELECT COALESCE(brand_name, name) AS brand FROM clients WHERE id = $1",
        client_id,
    )
    brand = (client_row["brand"] if client_row else "") or "ваш клиент"

    await _send_assistant_password_email(
        db,
        client_id=client_id,
        client_brand_name=brand,
        to_email=email_norm,
        password=password,
        is_reset=False,
    )

    return {
        "assistant": {
            "id": row["id"],
            "email": row["email"],
            "password": password,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
        }
    }


# ═════════════════════════════════════════════════════════════
# POST reset-password — сгенерить новый пароль и отправить
# ═════════════════════════════════════════════════════════════

@router.post("/reset-password", summary="Сбросить пароль ассистента")
async def reset_assistant_password(
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)

    row = await db.fetchrow(
        "SELECT id, email FROM client_assistants WHERE client_id = $1",
        client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Ассистент не подключён")

    password = _generate_password()
    pw_hash = hash_password(password)

    await db.execute(
        """UPDATE client_assistants
              SET password_hash = $1, password_plain = $2, updated_at = NOW()
            WHERE id = $3""",
        pw_hash, password, row["id"],
    )

    client_row = await db.fetchrow(
        "SELECT COALESCE(brand_name, name) AS brand FROM clients WHERE id = $1",
        client_id,
    )
    brand = (client_row["brand"] if client_row else "") or "ваш клиент"

    await _send_assistant_password_email(
        db,
        client_id=client_id,
        client_brand_name=brand,
        to_email=row["email"],
        password=password,
        is_reset=True,
    )

    return {"password": password}


# ═════════════════════════════════════════════════════════════
# DELETE — отключить ассистента
# ═════════════════════════════════════════════════════════════

@router.delete("", summary="Отключить ассистента полностью")
async def delete_assistant(
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    deleted = await db.execute(
        "DELETE FROM client_assistants WHERE client_id = $1", client_id
    )
    # asyncpg возвращает строку вида 'DELETE 1' / 'DELETE 0'
    if deleted.endswith(" 0"):
        raise HTTPException(status_code=404, detail="Ассистент не подключён")
    return {"ok": True}
