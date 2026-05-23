from fastapi import APIRouter, Depends, HTTPException, Request
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

    # Получаем тариф 'trial' и его длительность по умолчанию
    trial_tariff = await db.fetchrow(
        "SELECT id, default_duration_days FROM tariffs WHERE slug = 'trial'"
    )
    if not trial_tariff:
        raise HTTPException(status_code=500, detail="Тариф 'trial' не настроен в системе")
    trial_days = trial_tariff["default_duration_days"] or 60

    client = await db.fetchrow(
        """
        INSERT INTO clients (name, email, phone, telegram_username, password_hash, partner_code, integration_token)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, name, email
        """,
        data.name, data.email, data.phone, data.telegram_username, pw_hash, data.partner_code, _new_integration_token()
    )

    # Создаём активную подписку (миграция 069). Без неё middleware будет блокировать все write.
    sub_id = await db.fetchval(
        """INSERT INTO client_subscriptions
             (client_id, tariff_id, started_at, expires_at, status, source)
           VALUES ($1, $2, NOW(), NOW() + ($3 || ' days')::interval, 'active', 'trial')
           RETURNING id""",
        client["id"], trial_tariff["id"], str(trial_days)
    )
    await db.execute(
        "UPDATE clients SET current_subscription_id = $1 WHERE id = $2",
        sub_id, client["id"]
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
        "SELECT id, name, email, password_hash, is_active FROM clients WHERE email = $1",
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
        """SELECT c.id, c.name, c.email, c.phone, c.telegram_username,
                c.created_at, c.timezone,
                c.test_telegram_ids, c.test_vk_ids, c.test_max_ids, c.test_email_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency,
                c.notifications_telegram_chat_id,
                c.integration_token,
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
          WHERE c.id = $1""",
        client_id
    )
    if not client:
        raise HTTPException(status_code=404, detail="Клиент не найден")

    from app.services.features import get_client_features
    from app.services.subscriptions import get_subscription, days_until_expires

    features = await get_client_features(db, client_id)
    sub = await get_subscription(db, client_id)
    subscription = None
    if sub:
        subscription = {
            "tariff_slug":  sub["tariff_slug"],
            "tariff_name":  sub["tariff_name"],
            "tariff_price": float(sub["tariff_price"]) if sub["tariff_price"] is not None else 0,
            "started_at":   sub["started_at"].isoformat() if sub["started_at"] else None,
            "expires_at":   sub["expires_at"].isoformat() if sub["expires_at"] else None,
            "status":       sub["status"],
            "source":       sub["source"],
            "days_left":    days_until_expires(sub["expires_at"]),
            "is_active":    sub["status"] == "active" and days_until_expires(sub["expires_at"]) >= 0,
        }
    out = dict(client)
    out["features"] = features
    out["subscription"] = subscription
    # VK App ID подключённого Mini App (если есть) — фронт PublicLinks
    # подставляет его в реф-ссылку https://vk.com/app{ID}#ref_pg{slug}.
    # Без него ссылка вела бы на системный 54592404, а не на клиентский.
    from app.services.share_links import get_client_vk_app_id, get_active_platforms, _has_system_channel
    out["vk_app_id"] = await get_client_vk_app_id(db, client_id)
    # Какие платформы показывать в PublicLinks / RefLinkInline:
    # — те, где у клиента есть свой канал, ИЛИ есть системный НЕ в test-режиме.
    # Test-режим = админ ещё не вывел канал в прод (см. is_test в channels).
    avail = set(await get_active_platforms(db, client_id))
    for ps in ("telegram", "vk", "max"):
        if await _has_system_channel(db, ps, allow_test=False):
            avail.add(ps)
    out["available_platforms"] = sorted(avail)
    return out


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
    test_vk_ids: Optional[list] = None
    test_max_ids: Optional[list] = None
    test_email_ids: Optional[list] = None
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
            """SELECT c.id, c.name, c.email, c.phone, c.telegram_username,
                c.created_at, c.timezone,
                c.test_telegram_ids, c.test_vk_ids, c.test_max_ids, c.test_email_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency,
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
        """SELECT c.id, c.name, c.email, c.phone, c.telegram_username,
                  c.created_at, c.timezone,
                  c.test_telegram_ids, c.test_vk_ids, c.test_max_ids, c.test_email_ids, c.work_tg_username, c.work_tg_id, c.broadcast_concurrency,
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


# ─── Восстановление пароля по email ─────────────────────────────────────


class PasswordResetRequest(BaseModel):
    email: str


class PasswordResetConfirm(BaseModel):
    token: str
    new_password: str


@router.post("/password-reset/request", summary="Запросить восстановление пароля")
async def password_reset_request(
    data: PasswordResetRequest,
    request: Request,
    db: asyncpg.Connection = Depends(get_db),
):
    """
    Принимает email клиента — генерирует токен (живёт 1 час), сохраняет
    в password_reset_tokens (хеш токена), шлёт письмо со ссылкой
    https://pluson.ru/password-reset/confirm?token=...

    Всегда возвращает 200 OK — даже если email не зарегистрирован
    (чтобы не давать enumeration «у вас есть аккаунт / нет»).
    """
    import hashlib
    import secrets
    from datetime import datetime, timedelta

    email_norm = (data.email or "").strip().lower()
    if not email_norm or "@" not in email_norm:
        # Не раскрываем подробностей — отвечаем как успешный запрос
        return {"ok": True}

    row = await db.fetchrow(
        "SELECT id, email FROM clients WHERE LOWER(email) = $1",
        email_norm,
    )

    if row:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires_at = datetime.utcnow() + timedelta(hours=1)
        ip = (request.client.host if request and request.client else "") or ""
        await db.execute(
            """INSERT INTO password_reset_tokens
                   (client_id, token_hash, expires_at, ip_address)
                VALUES ($1, $2, $3, $4)""",
            row["id"], token_hash, expires_at, ip[:64],
        )

        # Шлём письмо с ссылкой через системный email-канал ПЛЮСОНа
        try:
            from app.services.email_sender import EmailSender, EmailSendError
            from app.services.unsubscribe_token import make_email_unsubscribe_token

            # Системный email-канал ПЛЮСОНа (is_system=TRUE) для клиента row["id"]
            ch = await db.fetchrow(
                """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                          ch.email_subdomain, ch.email_from_local
                     FROM client_channels cc
                     JOIN channels ch ON ch.id = cc.channel_id
                    WHERE cc.client_id = $1
                      AND ch.platform_slug = 'email'
                      AND ch.is_system = TRUE
                    LIMIT 1""",
                row["id"],
            )
            if ch:
                from app.config import settings as _s
                reset_url = f"{_s.frontend_url.rstrip('/')}/password-reset/confirm?token={token}"
                channel_dict = dict(ch)
                channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"

                # Заглушка для unsub-токена — для транзакционных писем
                # отписка не предполагается (это системные уведомления).
                # Но подвал отписки всё равно вставится — пусть будет.
                fake_unsub = make_email_unsubscribe_token(
                    client_id=row["id"], contact_id=0,
                    client_channel_id=ch["client_channel_id"],
                )

                sender = EmailSender()
                sender.send(
                    channel=channel_dict,
                    client_brand_name="iViSiON: ПЛЮСОН",
                    to_email=row["email"],
                    subject="Восстановление пароля — ПЛЮСОН",
                    body_text=(
                        f"Здравствуйте!\n\n"
                        f"Вы запросили восстановление пароля в личном кабинете ПЛЮСОНа.\n\n"
                        f"Перейдите по ссылке, чтобы задать новый пароль:\n"
                        f"{reset_url}\n\n"
                        f"Ссылка действует 1 час. Если вы не запрашивали восстановление — "
                        f"проигнорируйте это письмо.\n\n"
                        f"— Команда ПЛЮСОН"
                    ),
                    unsubscribe_token=fake_unsub,
                )
        except Exception:
            # SMTP-проблема не должна выдавать пользователю что email существует.
            pass

    return {"ok": True}


@router.post("/password-reset/confirm", summary="Подтвердить новый пароль")
async def password_reset_confirm(
    data: PasswordResetConfirm,
    db: asyncpg.Connection = Depends(get_db),
):
    import hashlib

    if not data.new_password or len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Пароль должен быть не короче 8 символов")

    token_hash = hashlib.sha256(data.token.encode()).hexdigest()
    row = await db.fetchrow(
        """SELECT id, client_id FROM password_reset_tokens
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
            LIMIT 1""",
        token_hash,
    )
    if not row:
        raise HTTPException(status_code=400, detail="Ссылка недействительна или устарела")

    new_hash = hash_password(data.new_password)
    async with db.transaction():
        await db.execute(
            "UPDATE clients SET password_hash = $1 WHERE id = $2",
            new_hash, row["client_id"],
        )
        await db.execute(
            "UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1",
            row["id"],
        )
    return {"ok": True}
