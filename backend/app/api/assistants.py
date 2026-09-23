"""
Помощники кабинета (миграции 106, 208, 209).

Связь «многие ко многим»: у клиента сколько угодно помощников, помощник ведёт
сколько угодно кабинетов. Человек живёт в `assistants` (почта + ОДИН пароль на
все кабинеты), допуск — в `assistant_grants` (client_id + уровень доступа).

⚠️ Владелец кабинета пароль помощника НЕ видит. Новому человеку пароль уходит
письмом на его почту; тому, у кого учётка уже есть, — только уведомление
«вам открыли доступ в кабинет X». Кнопка «Напомнить пароль» шлёт новый пароль
помощнику, владельцу его не показывают.

Вход помощника: почта + его пароль → если пропусков несколько, сервер отдаёт
список кабинетов и фронт спрашивает, куда войти (см. auth.py:login).

Почта, зарегистрированная клиентом ПЛЮСОНа, помощником быть не может — иначе
вход не решил бы, чей пароль спрашивать.
"""
import secrets
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr

from app.auth import decode_token, hash_password, security
from app.database import get_db

router = APIRouter(prefix="/clients/me/assistants", tags=["Помощники кабинета"])


def _normalize_level(value: Optional[str]) -> str:
    """'full' | 'limited' | 'orders' | 'leads'. Непонятное → 'limited' (безопасный default).

    ⚠️ 'orders' («менеджер заказов») — узкий уровень: «Контакты» и «Анкеты»,
    но ВСЕ контакты кабинета.
    ⚠️ 'leads' («менеджер лидов», миграция 484) — «Контакты» и CRM событий,
    но ТОЛЬКО закреплённые за ним люди (`contact_assignments`).
    Разрешительные списки путей живут в middleware, здесь мы лишь принимаем
    значение.
    """
    v = (value or "").strip().lower()
    if v in ("full", "orders", "leads"):
        return v
    return "limited"


def _generate_password(length: int = 12) -> str:
    """12 символов, латиница + цифры. Исключены визуально похожие 0/O/o/1/l/I."""
    alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"
    return "".join(secrets.choice(alphabet) for _ in range(length))


async def _require_owner(credentials: HTTPAuthorizationCredentials, db: asyncpg.Connection) -> int:
    """Возвращает client_id владельца кабинета. 403 помощнику, 401 без токена."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    if payload.get("role") == "assistant":
        raise HTTPException(status_code=403, detail="Помощник не может управлять помощниками")
    if payload.get("role") not in ("client", None):
        raise HTTPException(status_code=403, detail="Доступ запрещён")
    return int(payload["sub"])


async def _send_assistant_email(
    db: asyncpg.Connection,
    *,
    client_id: int,
    client_brand_name: str,
    to_email: str,
    kind: str,                     # 'new' | 'granted' | 'reset'
    password: Optional[str],       # для 'granted' — None
    access_level: str,
) -> bool:
    """Письмо помощнику через системный email-канал ПЛЮСОНа. True — отправлено.

    Владелец пароль не видит, поэтому письмо — единственный способ его передать:
    об ошибке отправки сообщаем наверх, а не глотаем.
    """
    try:
        from app.services.email_sender import EmailSender
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
            return False

        login_url = f"{_s.frontend_url.rstrip('/')}/login"
        channel_dict = dict(ch)
        channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"
        fake_unsub = make_email_unsubscribe_token(
            client_id=client_id, contact_id=0,
            client_channel_id=ch["client_channel_id"],
        )

        if access_level == "full":
            rights = (
                "У вас полный доступ к кабинету — как у самого владельца. "
                "Недоступны только раздел помощников, а также пароль и email владельца."
            )
        elif access_level == "orders":
            rights = (
                "Вам открыты два раздела: «Контакты» и «Анкеты». Вы разбираете "
                "заявки: смотрите ответы, отмечаете обработанные и пишете "
                "заметки. Остальные разделы кабинета вам не видны."
            )
        elif access_level == "leads":
            rights = (
                "Вам открыты «Контакты» и отслеживание в событиях. Вы видите "
                "только тех людей, которых за вами закрепил владелец кабинета, "
                "и можете писать им прямо из карточки. Остальные разделы "
                "кабинета и чужие люди вам не видны."
            )
        else:
            rights = (
                "Вы сможете работать с контактами, событиями, рассылками и реф-программой, "
                "но не сможете удалять данные и заходить в разделы «Каналы» и «Настройки»."
            )

        if kind == "granted":
            subject = f"Вам открыли доступ в кабинет «{client_brand_name}» — iViSiON: ПЛЮСОН"
            body = (
                f"Здравствуйте!\n\n"
                f"Клиент «{client_brand_name}» открыл вам доступ помощника в свой кабинет.\n\n"
                f"Адрес кабинета: {login_url}\n"
                f"Логин: {to_email}\n"
                f"Пароль: тот же, которым вы уже входите в ПЛЮСОН.\n\n"
                f"{rights}\n\n"
                f"После входа выберите кабинет «{client_brand_name}» из списка.\n\n"
                f"— Команда ПЛЮСОН"
            )
        else:
            verb = "обновил" if kind == "reset" else "подключил"
            subject = (
                "Обновлён пароль помощника — iViSiON: ПЛЮСОН"
                if kind == "reset"
                else "Вам выдан доступ помощника — iViSiON: ПЛЮСОН"
            )
            body = (
                f"Здравствуйте!\n\n"
                f"Клиент «{client_brand_name}» {verb} вам доступ помощника в свой кабинет "
                f"в iViSiON: ПЛЮСОН.\n\n"
                f"Адрес кабинета: {login_url}\n"
                f"Логин: {to_email}\n"
                f"Пароль: {password}\n\n"
                f"{rights}\n\n"
                f"Этот пароль — ваш: он один на все кабинеты, где вам открыли доступ.\n\n"
                f"— Команда ПЛЮСОН"
            )

        EmailSender().send(
            channel=channel_dict,
            client_brand_name="iViSiON: ПЛЮСОН",
            to_email=to_email,
            subject=subject,
            body_text=body,
            unsubscribe_token=fake_unsub,
        )
        return True
    except Exception:
        return False


async def _brand(db: asyncpg.Connection, client_id: int) -> str:
    row = await db.fetchrow(
        "SELECT COALESCE(brand_name, name) AS brand FROM clients WHERE id = $1", client_id
    )
    return (row["brand"] if row else "") or "ваш клиент"


# ═════════════════════════════════════════════════════════════
# GET — список помощников кабинета
# ═════════════════════════════════════════════════════════════

@router.get("", summary="Помощники этого кабинета")
async def list_assistants(
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    rows = await db.fetch(
        """SELECT g.id AS grant_id, g.access_level, g.created_at,
                  a.id AS assistant_id, a.email, a.name, a.last_login_at,
                  (SELECT COUNT(*) FROM assistant_grants g2 WHERE g2.assistant_id = a.id) AS cabinets
             FROM assistant_grants g
             JOIN assistants a ON a.id = g.assistant_id
            WHERE g.client_id = $1
            ORDER BY g.created_at""",
        client_id,
    )
    return {
        "assistants": [
            {
                "grant_id": r["grant_id"],
                "assistant_id": r["assistant_id"],
                "email": r["email"],
                "name": r["name"],
                "access_level": r["access_level"],
                "cabinets": int(r["cabinets"]),
                "last_login_at": r["last_login_at"].isoformat() if r["last_login_at"] else None,
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]
    }


# ═════════════════════════════════════════════════════════════
# POST — подключить помощника
# ═════════════════════════════════════════════════════════════

class CreateAssistantRequest(BaseModel):
    email: EmailStr
    access_level: Optional[str] = "limited"


@router.post("", summary="Подключить помощника")
async def create_assistant(
    data: CreateAssistantRequest,
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    email_norm = data.email.strip().lower()
    level = _normalize_level(data.access_level)

    # ⚠️⚠️ ЗАПРЕТ «почта клиента не может быть помощником» СНЯТ (23.09.2026).
    # Он стоял с обоснованием «при входе система не поймёт, чей пароль
    # проверять», и это обоснование больше не действует: куда пускать человека,
    # решает ФОРМА входа, а не перебор ролей (см. миграцию 486 и /tech/login).
    # Клиент ПЛЮСОНа — обычный человек, и он вполне может помогать в чужом
    # кабинете: так работают внедренцы, у которых свой кабинет уже есть.
    #
    # ⚠️ Из-за запрета таким людям заводили почты-алиасы (`имя+pluson@…`), а это
    # ровно та подпорка, от которой мы ушли: у одного человека появлялись две
    # почты и две учётки вместо одной.
    if await db.fetchval("SELECT 1 FROM admins WHERE LOWER(email) = $1", email_norm):
        raise HTTPException(status_code=409, detail="Этот email занят. Выберите другой.")

    existing = await db.fetchrow(
        "SELECT id FROM assistants WHERE LOWER(email) = $1", email_norm
    )

    brand = await _brand(db, client_id)
    password: Optional[str] = None

    if existing:
        assistant_id = existing["id"]
        already = await db.fetchval(
            "SELECT 1 FROM assistant_grants WHERE assistant_id = $1 AND client_id = $2",
            assistant_id, client_id,
        )
        if already:
            raise HTTPException(status_code=409, detail="Этот помощник уже подключён к кабинету.")
        kind = "granted"   # пароль у человека уже есть — шлём только уведомление
    else:
        password = _generate_password()
        assistant_id = await db.fetchval(
            "INSERT INTO assistants (email, password_hash) VALUES ($1, $2) RETURNING id",
            email_norm, hash_password(password),
        )
        kind = "new"

    grant = await db.fetchrow(
        """INSERT INTO assistant_grants (assistant_id, client_id, access_level)
           VALUES ($1, $2, $3)
           RETURNING id, access_level, created_at""",
        assistant_id, client_id, level,
    )

    sent = await _send_assistant_email(
        db, client_id=client_id, client_brand_name=brand, to_email=email_norm,
        kind=kind, password=password, access_level=level,
    )

    return {
        "assistant": {
            "grant_id": grant["id"],
            "assistant_id": assistant_id,
            "email": email_norm,
            "access_level": grant["access_level"],
            "created_at": grant["created_at"].isoformat() if grant["created_at"] else None,
        },
        "is_new_account": kind == "new",
        "email_sent": sent,
    }


# ═════════════════════════════════════════════════════════════
# PATCH — сменить уровень доступа в ЭТОМ кабинете
# ═════════════════════════════════════════════════════════════

class UpdateAssistantRequest(BaseModel):
    access_level: str


@router.patch("/{grant_id}", summary="Сменить уровень доступа помощника")
async def update_assistant(
    grant_id: int,
    data: UpdateAssistantRequest,
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    level = _normalize_level(data.access_level)
    row = await db.fetchrow(
        """UPDATE assistant_grants SET access_level = $1, updated_at = NOW()
            WHERE id = $2 AND client_id = $3
        RETURNING id, access_level""",
        level, grant_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Помощник не найден в этом кабинете")
    # Права применяются сразу — middleware читает уровень из пропуска на каждый запрос.
    return {"grant_id": row["id"], "access_level": row["access_level"]}


# ═════════════════════════════════════════════════════════════
# POST reset-password — новый пароль ПОМОЩНИКУ на его почту
# ═════════════════════════════════════════════════════════════

@router.post("/{grant_id}/reset-password", summary="Напомнить пароль помощнику (письмом)")
async def reset_assistant_password(
    grant_id: int,
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    row = await db.fetchrow(
        """SELECT a.id, a.email, g.access_level
             FROM assistant_grants g JOIN assistants a ON a.id = g.assistant_id
            WHERE g.id = $1 AND g.client_id = $2""",
        grant_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Помощник не найден в этом кабинете")

    password = _generate_password()
    await db.execute(
        "UPDATE assistants SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        hash_password(password), row["id"],
    )

    brand = await _brand(db, client_id)
    sent = await _send_assistant_email(
        db, client_id=client_id, client_brand_name=brand, to_email=row["email"],
        kind="reset", password=password, access_level=row["access_level"],
    )
    if not sent:
        raise HTTPException(
            status_code=502,
            detail="Не удалось отправить письмо с паролем. Попробуйте ещё раз или напишите в поддержку.",
        )
    # Пароль владельцу НЕ возвращаем — он ушёл помощнику на почту.
    return {"ok": True, "email": row["email"]}


# ═════════════════════════════════════════════════════════════
# DELETE — отозвать доступ в ЭТОТ кабинет
# ═════════════════════════════════════════════════════════════

@router.delete("/{grant_id}", summary="Отозвать доступ помощника в этот кабинет")
async def delete_assistant(
    grant_id: int,
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(security),
):
    client_id = await _require_owner(credentials, db)
    row = await db.fetchrow(
        "DELETE FROM assistant_grants WHERE id = $1 AND client_id = $2 RETURNING assistant_id",
        grant_id, client_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Помощник не найден в этом кабинете")

    # Человек без единого пропуска в системе не нужен — удаляем учётку.
    # Если он помогает другим клиентам, учётка и её пароль остаются нетронутыми.
    left = await db.fetchval(
        "SELECT COUNT(*) FROM assistant_grants WHERE assistant_id = $1", row["assistant_id"]
    )
    if not left:
        await db.execute("DELETE FROM assistants WHERE id = $1", row["assistant_id"])
    return {"ok": True}
