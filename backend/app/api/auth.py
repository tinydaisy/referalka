from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from typing import Optional
from app.auth import hash_password, verify_password, create_token
from app.database import get_db
import asyncpg
from datetime import timedelta

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
        INSERT INTO clients (name, email, phone, telegram_username, password_hash, tariff_slug, trial_ends_at, partner_code)
        VALUES ($1, $2, $3, $4, $5, 'beta', NOW() + INTERVAL '12 months', $6)
        RETURNING id, name, email, tariff_slug, trial_ends_at
        """,
        data.name, data.email, data.phone, data.telegram_username, pw_hash, data.partner_code
    )

    # Подключаем базовый модуль
    await db.execute(
        "INSERT INTO client_modules (client_id, module_slug) VALUES ($1, 'base') ON CONFLICT DO NOTHING",
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
        "SELECT id, name, email, phone, telegram_username, tariff_slug, trial_ends_at, created_at, timezone, bot_token, test_telegram_ids FROM clients WHERE id = $1",
        client_id
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    return dict(client)


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    telegram_username: Optional[str] = None
    timezone: Optional[str] = None
    bot_token: Optional[str] = None
    test_telegram_ids: Optional[list] = None


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
            "SELECT id, name, email, phone, telegram_username, tariff_slug, trial_ends_at, created_at, timezone, bot_token, test_telegram_ids FROM clients WHERE id = $1",
            client_id
        )
        return dict(client)
    set_parts = [f"{k} = ${i+2}" for i, k in enumerate(updates.keys())]
    client = await db.fetchrow(
        f"UPDATE clients SET {', '.join(set_parts)} WHERE id=$1 RETURNING id, name, email, phone, telegram_username, tariff_slug, trial_ends_at, created_at, timezone, bot_token, test_telegram_ids",
        client_id, *updates.values()
    )
    return dict(client)
