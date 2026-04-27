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
        """SELECT c.id, c.name, c.email, c.phone, c.telegram_username, c.tariff_slug,
                c.trial_ends_at, c.created_at, c.timezone,
                EXISTS (SELECT 1 FROM channels
                        WHERE client_id = c.id AND platform_slug = 'telegram'
                          AND is_active = TRUE AND bot_token IS NOT NULL
                          AND bot_token <> '') AS bot_token_set,
                c.test_telegram_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency
           FROM clients c WHERE c.id = $1""",
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
    work_tg_username: Optional[str] = None
    work_tg_id: Optional[int] = None
    broadcast_concurrency: Optional[int] = None


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
                EXISTS (SELECT 1 FROM channels
                        WHERE client_id = c.id AND platform_slug = 'telegram'
                          AND is_active = TRUE AND bot_token IS NOT NULL
                          AND bot_token <> '') AS bot_token_set,
                c.test_telegram_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency
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

    # bot_token больше не живёт в clients — пишем в channels.
    # Пустую строку трактуем как «не менять».
    # Дополнительно валидируем формат `123456789:AAA...` — защита от Chrome
    # autofill, который иногда подсовывает пароль клиента в это поле.
    import re
    new_bot_token = updates.pop("bot_token", None)
    if new_bot_token is not None and new_bot_token.strip():
        token = new_bot_token.strip()
        if not re.match(r"^\d{6,15}:[A-Za-z0-9_-]{30,}$", token):
            raise HTTPException(
                status_code=400,
                detail="Не похоже на Telegram-токен. Формат: 123456789:AAFxx... "
                       "Если в поле случайно попал ваш пароль — очистите поле и сохраните повторно.",
            )
        from app.services.channels import upsert_client_telegram_token
        await upsert_client_telegram_token(client_id, token, db)

    if updates:
        set_parts = [f"{k} = ${i+2}" for i, k in enumerate(updates.keys())]
        await db.execute(
            f"UPDATE clients SET {', '.join(set_parts)} WHERE id=$1",
            client_id, *updates.values()
        )

    client = await db.fetchrow(
        """SELECT c.id, c.name, c.email, c.phone, c.telegram_username, c.tariff_slug,
                  c.trial_ends_at, c.created_at, c.timezone,
                  (SELECT bot_token FROM channels
                   WHERE client_id = c.id AND platform_slug = 'telegram' AND is_active = TRUE
                   ORDER BY id LIMIT 1) AS bot_token,
                  c.test_telegram_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency
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
