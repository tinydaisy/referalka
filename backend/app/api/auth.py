from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from typing import Optional
from app.auth import hash_password, verify_password, create_token
from app.database import get_db
import asyncpg
import secrets
from datetime import timedelta


def _new_integration_token() -> str:
    """64 hex-символа (256 бит энтропии) — для интеграции с Salebot и др. чат-ботами."""
    return secrets.token_hex(32)

router = APIRouter(prefix="/auth", tags=["Авторизация"])


class RegisterRequest(BaseModel):
    name: str
    email: EmailStr
    phone: str | None = None
    telegram_username: str | None = None
    password: str
    partner_code: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class AdminLoginRequest(BaseModel):
    email: EmailStr
    password: str


@router.post("/register", summary="Регистрация нового клиента")
async def register(data: RegisterRequest, db: asyncpg.Connection = Depends(get_db)):
    # Проверяем, не занят ли email
    existing = await db.fetchrow("SELECT id FROM clients WHERE email = $1", data.email)
    if existing:
        raise HTTPException(status_code=409, detail="Этот email уже зарегистрирован")

    # Проверяем partner_code если передан
    if data.partner_code:
        partner = await db.fetchrow("SELECT id FROM partners WHERE partner_code = $1", data.partner_code)
        if not partner:
            data.partner_code = None  # Неверный код — просто игнорируем

    pw_hash = hash_password(data.password)

    client = await db.fetchrow(
        """
        INSERT INTO clients (name, email, phone, telegram_username, password_hash, tariff_slug, trial_ends_at, partner_code, integration_token)
        VALUES ($1, $2, $3, $4, $5, 'beta', NOW() + INTERVAL '12 months', $6, $7)
        RETURNING id, name, email, tariff_slug, trial_ends_at
        """,
        data.name, data.email, data.phone, data.telegram_username, pw_hash, data.partner_code, _new_integration_token()
    )

    # Подключаем базовый модуль
    await db.execute(
        "INSERT INTO client_modules (client_id, module_slug) VALUES ($1, 'base') ON CONFLICT DO NOTHING",
        client["id"]
    )

    # Архитектура G: создаём записи в client_channels для всех боевых системных каналов
    # (is_system=TRUE AND is_test=FALSE). Они автоматом доступны клиенту с момента
    # регистрации. Для не-VIP активный канал — этот системный (раз других нет).
    await db.execute(
        """INSERT INTO client_channels (client_id, channel_id, is_active)
           SELECT $1, ch.id, TRUE
             FROM channels ch
            WHERE ch.is_system = TRUE AND ch.is_test = FALSE""",
        client["id"]
    )

    token = create_token({"sub": str(client["id"]), "email": client["email"], "role": "client"})

    return {
        "access_token": token,
        "token_type": "bearer",
        "client": dict(client),
        "message": "Регистрация прошла успешно! Добро пожаловать в ПЛЮСОН."
    }


@router.post("/login", summary="Вход клиента или администратора")
async def login(data: LoginRequest, db: asyncpg.Connection = Depends(get_db)):
    # Пробуем залогинить как клиента
    client = await db.fetchrow(
        "SELECT id, name, email, password_hash, tariff_slug, is_active FROM clients WHERE email = $1",
        data.email
    )
    if client and verify_password(data.password, client["password_hash"]):
        if not client["is_active"]:
            raise HTTPException(status_code=403, detail="Аккаунт заблокирован. Напишите в поддержку.")

        token = create_token({"sub": str(client["id"]), "email": client["email"], "role": "client"})
        return {
            "access_token": token,
            "token_type": "bearer",
            "client": {
                "id": client["id"],
                "name": client["name"],
                "email": client["email"],
                "tariff_slug": client["tariff_slug"]
            }
        }

    # Пробуем залогинить как администратора
    admin = await db.fetchrow(
        "SELECT id, name, email, password_hash, is_superadmin FROM admins WHERE email = $1",
        data.email
    )
    if admin and verify_password(data.password, admin["password_hash"]):
        token = create_token({"sub": str(admin["id"]), "email": admin["email"], "role": "admin"})
        return {
            "access_token": token,
            "token_type": "bearer",
            "admin": {"id": admin["id"], "name": admin["name"], "is_superadmin": admin["is_superadmin"]}
        }

    # Если ничего не найдено
    raise HTTPException(status_code=401, detail="Неверный email или пароль")


@router.post("/admin/login", summary="Вход администратора")
async def admin_login(data: AdminLoginRequest, db: asyncpg.Connection = Depends(get_db)):
    admin = await db.fetchrow(
        "SELECT id, name, email, password_hash, is_superadmin FROM admins WHERE email = $1",
        data.email
    )
    if not admin or not verify_password(data.password, admin["password_hash"]):
        raise HTTPException(status_code=401, detail="Неверный email или пароль")

    token = create_token({"sub": str(admin["id"]), "email": admin["email"], "role": "admin"})

    return {
        "access_token": token,
        "token_type": "bearer",
        "admin": {"id": admin["id"], "name": admin["name"], "is_superadmin": admin["is_superadmin"]}
    }


@router.get("/me", summary="Данные текущего клиента")
async def get_me(db: asyncpg.Connection = Depends(get_db), credentials=Depends(__import__("app.auth", fromlist=["security"]).security)):
    from app.auth import decode_token
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    client_id = int(payload["sub"])
    client = await db.fetchrow(
        """SELECT c.id, c.name, c.email, c.phone, c.telegram_username, c.tariff_slug,
                c.trial_ends_at, c.created_at, c.timezone,
                c.test_telegram_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency,
                c.notifications_telegram_chat_id,
                c.integration_token,
                t.name AS tariff_name,
                COALESCE(t.allow_custom_bot, false) AS allow_custom_bot,
                (SELECT REGEXP_REPLACE(ch.handle, '^@', '')
                   FROM channels ch
                   JOIN client_channels cc ON cc.channel_id = ch.id
                  WHERE cc.client_id = c.id
                    AND ch.platform_slug = 'telegram'
                    AND cc.is_active = TRUE
                    AND ch.is_system = FALSE
                    AND ch.bot_token IS NOT NULL
                  LIMIT 1) AS main_bot_handle
           FROM clients c
           LEFT JOIN tariffs t ON t.slug = c.tariff_slug
          WHERE c.id = $1""",
        client_id
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return dict(client)


@router.post("/me/regenerate-integration-token", summary="Перевыпустить токен интеграции")
async def regenerate_integration_token(
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(__import__("app.auth", fromlist=["security"]).security),
):
    from app.auth import decode_token
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    client_id = int(payload["sub"])
    new_token = _new_integration_token()
    await db.execute(
        "UPDATE clients SET integration_token = $1 WHERE id = $2",
        new_token, client_id
    )
    return {"integration_token": new_token}


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    timezone: Optional[str] = None
    test_telegram_ids: Optional[list] = None
    work_tg_username: Optional[str] = None
    work_tg_id: Optional[int] = None
    broadcast_concurrency: Optional[int] = None
    notifications_telegram_chat_id: Optional[int] = None


@router.patch("/me", summary="Обновить профиль клиента")
async def update_me(
    data: ProfileUpdate,
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(__import__("app.auth", fromlist=["security"]).security)
):
    from app.auth import decode_token
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    client_id = int(payload["sub"])
    updates = {k: v for k, v in data.model_dump(exclude_unset=True).items()}
    if not updates:
        client = await db.fetchrow(
            """SELECT c.id, c.name, c.email, c.phone, c.telegram_username, c.tariff_slug,
                c.trial_ends_at, c.created_at, c.timezone,
                c.test_telegram_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency,
                  c.notifications_telegram_chat_id
           FROM clients c WHERE c.id = $1""",
            client_id
        )
        return dict(client)
    # Валидация broadcast_concurrency: 1..100
    if "broadcast_concurrency" in updates and updates["broadcast_concurrency"] is not None:
        bc = int(updates["broadcast_concurrency"])
        if bc < 1 or bc > 100:
            raise HTTPException(status_code=400, detail="Скорость рассылки: допустимый диапазон 1..100")
        updates["broadcast_concurrency"] = bc

    # bot_token живёт только в channels (раздел «Каналы» в дашборде).
    # Этот эндпоинт его больше не принимает — игнорируем если кто-то прислал.
    updates.pop("bot_token", None)

    if updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(updates.keys())]
        await db.execute(
            f"UPDATE clients SET {', '.join(set_parts)} WHERE id=$1",
            client_id, *updates.values()
        )

    client = await db.fetchrow(
        """SELECT c.id, c.name, c.email, c.phone, c.telegram_username, c.tariff_slug,
                  c.trial_ends_at, c.created_at, c.timezone,
                  c.test_telegram_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency,
                  c.notifications_telegram_chat_id
             FROM clients c WHERE c.id = $1""",
        client_id
    )
    return dict(client)


# ═══════════════════════════════════════════
# Смена пароля клиента
# ═══════════════════════════════════════════

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password", summary="Сменить пароль клиента")
async def change_password(
    data: ChangePasswordRequest,
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(__import__("app.auth", fromlist=["security"]).security),
):
    from app.auth import decode_token
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    client_id = int(payload["sub"])

    if not data.new_password or len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Новый пароль должен быть не короче 8 символов")

    row = await db.fetchrow("SELECT password_hash FROM clients WHERE id = $1", client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    if not verify_password(data.current_password, row["password_hash"]):
        raise HTTPException(status_code=400, detail="Текущий пароль неверный")

    new_hash = hash_password(data.new_password)
    await db.execute("UPDATE clients SET password_hash = $1 WHERE id = $2", new_hash, client_id)
    return {"ok": True}
