from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
from typing import Optional
from app.auth import hash_password, verify_password, create_token
from app.database import get_db
from app.services.plusson_referral import resolve_plusson_referrer
import asyncpg
import logging
import secrets
from datetime import timedelta

logger = logging.getLogger(__name__)


# Сколько дополнительных дней триала получает клиент, пришедший по реф-коду
# (реф-программа ПЛЮСОНа). Плюсуется ПОВЕРХ базового триала и активной промо.
REFERRAL_TRIAL_BONUS_DAYS = 7


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
    pid: str | None = None  # реф-код пригласившего клиента (миграция 125)
    # Идентичность на площадке (если регистрация пришла из МедиаЛифта прямо из
    # бота): передаётся гет-параметром, чтобы СРАЗУ связать карточку коллаба
    # этого человека в событии medialift с новым клиентским аккаунтом.
    ml_tg_id: str | None = None
    ml_vk_id: str | None = None
    ml_max_id: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    # Помощник кабинета может вести несколько кабинетов (миграция 209).
    # Первый вход без client_id: если пропусков больше одного — сервер отдаёт
    # список кабинетов, фронт спрашивает «куда войти» и повторяет запрос с client_id.
    client_id: int | None = None


class AdminLoginRequest(BaseModel):
    email: EmailStr
    password: str


@router.post("/register", summary="Регистрация нового клиента")
async def register(data: RegisterRequest, db: asyncpg.Connection = Depends(get_db)):
    # Email всегда храним в нижнем регистре — иначе регистр развёл бы один и тот
    # же адрес на несколько аккаунтов (Gmail и почти все почтовики регистр
    # игнорируют, а точечное сравнение при входе — нет).
    data.email = (data.email or "").strip().lower()

    # Проверяем, не занят ли email (регистронезависимо)
    existing = await db.fetchrow("SELECT id FROM clients WHERE LOWER(email) = $1", data.email)
    if existing:
        raise HTTPException(status_code=409, detail="Этот email уже зарегистрирован")

    # Проверяем partner_code если передан
    if data.partner_code:
        partner = await db.fetchrow("SELECT id FROM partners WHERE partner_code = $1", data.partner_code)
        if not partner:
            data.partner_code = None  # Неверный код — просто игнорируем

    # Разрешаем pid → referred_by_client_id (миграция 125).
    # pid может быть ЛИБО клиентским кодом (clients.referral_code), ЛИБО
    # кодом-контактом рефовода-спикера с привязанным ПЛЮСОНом — общий резолвер
    # понимает оба и возвращает нужного клиента. Невалидный код → None (без связи).
    referred_by_client_id = await resolve_plusson_referrer(db, data.pid)

    # Фолбэк (миграция 206): если в URL не было pid, но человек ранее заходил в
    # ЛЮБОЙ VIP-бот по ссылке /start ref<код> — код закреплён за его контактом
    # (contacts.plusson_referrer_code). Находим контакт по email/телефону/TG-нику
    # и резолвим сохранённый код. Так привязка к рефоводу переживает то, что
    # человек не нажал кнопку регистрации сразу из бота.
    if not referred_by_client_id:
        _uname = (data.telegram_username or "").lstrip("@").strip().lower()
        _phone_digits = "".join(ch for ch in (data.phone or "") if ch.isdigit())
        saved_code = await db.fetchval(
            """SELECT c.plusson_referrer_code
                 FROM contacts c
                 LEFT JOIN platform_users p
                        ON p.contact_id = c.id AND p.platform_slug = 'telegram'
                WHERE c.plusson_referrer_code IS NOT NULL
                  AND c.plusson_referrer_code <> ''
                  AND (
                        ($1 <> '' AND LOWER(c.email) = $1)
                     OR ($2 <> '' AND regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') = $2)
                     OR ($3 <> '' AND LOWER(p.username) = $3)
                      )
                ORDER BY c.first_referred_at NULLS LAST, c.id
                LIMIT 1""",
            data.email, _phone_digits, _uname,
        )
        if saved_code:
            referred_by_client_id = await resolve_plusson_referrer(db, saved_code)

    # Генерим реф-код для нового клиента
    import random
    alphabet = '23456789abcdefghjkmnpqrstuvwxyz'
    new_referral_code = None
    for _ in range(20):  # 20 попыток на коллизию (вероятность ~0)
        candidate = ''.join(random.choice(alphabet) for _ in range(8))
        exists = await db.fetchval("SELECT 1 FROM clients WHERE referral_code = $1", candidate)
        if not exists:
            new_referral_code = candidate
            break
    if not new_referral_code:
        raise HTTPException(status_code=500, detail="Не удалось сгенерировать реф-код")

    pw_hash = hash_password(data.password)

    # Получаем тариф 'trial' и его длительность по умолчанию
    trial_tariff = await db.fetchrow(
        "SELECT id, default_duration_days FROM tariffs WHERE slug = 'trial'"
    )
    if not trial_tariff:
        raise HTTPException(status_code=500, detail="Тариф 'trial' не настроен в системе")
    base_trial_days = trial_tariff["default_duration_days"] or 14

    # Применение активной promo `trial_bonus_days` для тарифа `trial`.
    # Под FOR UPDATE, чтобы used_count++ и проверка max_uses были атомарны
    # относительно конкурентных регистраций.
    applied_promo = None
    async with db.transaction():
        promo = await db.fetchrow(
            """SELECT id, name, value, max_uses, used_count
                 FROM promotions
                WHERE is_active = TRUE
                  AND type = 'trial_bonus_days'
                  AND (target_tariff_slug IS NULL OR target_tariff_slug = 'trial')
                  AND (starts_at IS NULL OR starts_at <= NOW())
                  AND (ends_at   IS NULL OR ends_at   >  NOW())
                  AND (max_uses  IS NULL OR used_count < max_uses)
                ORDER BY id
                LIMIT 1
                FOR UPDATE"""
        )
        bonus_days = 0
        if promo:
            bonus_days = int(promo["value"] or 0)
            await db.execute(
                "UPDATE promotions SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1",
                promo["id"],
            )
            applied_promo = {"id": promo["id"], "name": promo["name"], "bonus_days": bonus_days}
        # Реф-бонус: пришёл по валидному реф-коду → +7 дней триала поверх базы и
        # промо-акции. referred_by_client_id уже отрезолвлен выше (None если код
        # невалидный/мусорный — тогда бонуса нет).
        referral_bonus_days = REFERRAL_TRIAL_BONUS_DAYS if referred_by_client_id else 0
        trial_days = base_trial_days + bonus_days + referral_bonus_days

        client = await db.fetchrow(
            """
            INSERT INTO clients (name, email, phone, telegram_username, password_hash, partner_code, integration_token,
                                 referral_code, referred_by_client_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, name, email
            """,
            data.name, data.email, data.phone, data.telegram_username, pw_hash, data.partner_code, _new_integration_token(),
            new_referral_code, referred_by_client_id,
        )

        # Создаём запись бонусного баланса (NULL не допустим, всегда нулевая запись)
        await db.execute(
            "INSERT INTO client_bonus_balance (client_id, balance_kopecks) VALUES ($1, 0) ON CONFLICT DO NOTHING",
            client["id"],
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

        # Архитектура G: новым клиентам привязываем ТОЛЬКО системный email-канал.
        # Общие TG/VK/MAX-каналы ПЛЮСОНа как fallback больше не используются —
        # у всех клиентов есть собственный бот/сообщество. Системный email
        # (рассылки-письма, welcome) остаётся доступен с момента регистрации.
        await db.execute(
            """INSERT INTO client_channels (client_id, channel_id, is_active)
               SELECT $1, ch.id, TRUE
                 FROM channels ch
                WHERE ch.is_system = TRUE AND ch.is_test = FALSE
                  AND ch.platform_slug = 'email'""",
            client["id"]
        )

        # Коллабораторная: сразу заводим клиенту его карточку-коллаб (contact + collaborator
        # из профиля) и пишем clients.self_collaborator_id (миграция 141). Эту карточку
        # можно добавлять организатором/спикером в любые события без дублей.
        from app.services.self_collaborator import ensure_self_collaborator
        await ensure_self_collaborator(db, client["id"])

        # МедиаЛифт: если человек регистрируется ПРЯМО из воронки (id платформы
        # пришёл гет-параметром) — сразу связываем его карточку-коллаба в событии
        # medialift с этим новым аккаунтом (collaborators.linked_client_id).
        # Связка идёт ПО КАРТОЧКЕ коллаба (не по платформе): участник МедиаЛифта =
        # коллаб, у него уже есть карточка, привязанная к его platform_users.
        ml_pairs = [("telegram", data.ml_tg_id), ("vk", data.ml_vk_id), ("max", data.ml_max_id)]
        for _plat, _pid in ml_pairs:
            if not _pid:
                continue
            try:
                await db.execute(
                    """UPDATE collaborators c
                          SET linked_client_id = $1
                         FROM event_collaborators ec
                         JOIN events e ON e.id = ec.event_id AND e.module_slug = 'medialift'
                         JOIN platform_users pu ON pu.contact_id = c.contact_id
                                               AND pu.platform_slug = $2
                                               AND pu.platform_user_id = $3::text
                        WHERE ec.speaker_id = c.id
                          AND c.linked_client_id IS NULL""",
                    client["id"], _plat, str(_pid))
            except Exception:
                pass  # связка не критична для регистрации

    token = create_token({"sub": str(client["id"]), "email": client["email"], "role": "client"})

    # Письмо с подтверждением email (от «iViSiON: ПЛЮСОН»). Отправляем В ФОНЕ —
    # send() внутри делает СИНХРОННЫЙ блокирующий SMTP-вызов, и если сервер
    # тормозит, register висел до 5 мин (кнопка «Регистрируем…» не отпускала).
    # Фоновая задача берёт СВОЁ соединение из пула (текущее db освободится сразу
    # после return). Ошибки/таймауты SMTP на регистрацию не влияют.
    import asyncio as _asyncio

    async def _send_welcome_email_bg(client_id: int):
        try:
            from app.database import get_pool
            from app.services.email_verification import send_verification_email
            pool = await get_pool()
            if pool is None:
                return
            async with pool.acquire() as conn:
                await send_verification_email(conn, client_id)
        except Exception:
            pass

    _asyncio.create_task(_send_welcome_email_bg(client["id"]))

    return {
        "access_token": token,
        "token_type": "bearer",
        "client": dict(client),
        "trial_days": trial_days,
        "promo_applied": applied_promo,
        "message": "Регистрация прошла успешно! Добро пожаловать в ПЛЮСОН."
    }


@router.get("/referrer-info", summary="Проверить реф-код (pid) для лендинга")
async def referrer_info(
    pid: str | None = None, db: asyncpg.Connection = Depends(get_db)
):
    """Публичная валидация реф-кода с лендинга.

    Возвращает {valid, referrer_name, bonus_days} — лендинг по этому показывает
    персональную плашку «вас пригласил X, вам +7 дней триала». Невалидный/
    мусорный/несуществующий pid → {valid: false} (плашка не показывается,
    бонуса не будет). Резолв — тот же, что в /register (понимает и клиентский
    код, и код-контакт спикера с привязанным ПЛЮСОНом)."""
    if not pid:
        return {"valid": False}
    client_id = await resolve_plusson_referrer(db, pid)
    if not client_id:
        return {"valid": False}
    # Имя ОСНОВАТЕЛЯ (clients.name), не бренд — «Вас пригласил Марго Форбс»,
    # а не «Вас пригласил ВИДЕНИЕ / iViSiON».
    name = await db.fetchval(
        "SELECT name FROM clients WHERE id = $1", client_id,
    )
    # Итоговое число дней триала = база тарифа trial + реф-бонус (+ активная промо,
    # если есть). Чтобы на лендинге писать конкретно «37 дней», а не «на 7 больше».
    base_days = await db.fetchval(
        "SELECT default_duration_days FROM tariffs WHERE slug = 'trial'"
    ) or 14
    promo_bonus = await db.fetchval(
        """SELECT value FROM promotions
            WHERE is_active = TRUE AND type = 'trial_bonus_days'
              AND (target_tariff_slug IS NULL OR target_tariff_slug = 'trial')
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (ends_at   IS NULL OR ends_at   >  NOW())
              AND (max_uses  IS NULL OR used_count < max_uses)
            ORDER BY id LIMIT 1"""
    ) or 0
    total_days = int(base_days) + int(promo_bonus) + REFERRAL_TRIAL_BONUS_DAYS
    return {
        "valid": True,
        "referrer_name": name or "",
        "bonus_days": REFERRAL_TRIAL_BONUS_DAYS,
        "total_days": total_days,
    }


@router.post("/login", summary="Вход клиента или администратора")
async def login(data: LoginRequest, db: asyncpg.Connection = Depends(get_db)):
    # Email регистронезависимо: вход по адресу в любом регистре.
    data.email = (data.email or "").strip().lower()

    # Пробуем залогинить как клиента
    client = await db.fetchrow(
        "SELECT id, name, email, password_hash, is_active FROM clients WHERE LOWER(email) = $1",
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

    # Пробуем залогинить как помощника кабинета (миграции 105, 208, 209).
    # Один человек — один пароль и сколько угодно кабинетов. JWT привязан к ОДНОМУ
    # кабинету: sub = client_id, grant_id = номер пропуска (в нём уровень доступа).
    asst = await db.fetchrow(
        "SELECT id, email, password_hash FROM assistants WHERE LOWER(email) = LOWER($1)",
        data.email
    )
    if asst and verify_password(data.password, asst["password_hash"]):
        grants = await db.fetch(
            """SELECT g.id AS grant_id, g.client_id, g.access_level,
                      c.name AS owner_name, c.brand_name, c.is_active
                 FROM assistant_grants g
                 JOIN clients c ON c.id = g.client_id
                WHERE g.assistant_id = $1
                ORDER BY COALESCE(c.brand_name, c.name), c.id""",
            asst["id"],
        )
        live = [g for g in grants if g["is_active"]]
        if not live:
            raise HTTPException(
                status_code=403,
                detail="Доступ отозван. Попросите владельца кабинета подключить вас заново.",
            )

        # Кабинет ещё не выбран, а их несколько — отдаём список, вход не выдаём.
        if data.client_id is None and len(live) > 1:
            return {
                "choose_client": True,
                "clients": [
                    {
                        "id": g["client_id"],
                        "brand_name": g["brand_name"] or g["owner_name"],
                        "owner_name": g["owner_name"],
                        "access_level": g["access_level"],
                    }
                    for g in live
                ],
            }

        chosen = next((g for g in live if g["client_id"] == data.client_id), None) if data.client_id else live[0]
        if not chosen:
            raise HTTPException(status_code=403, detail="У вас нет доступа в этот кабинет.")

        await db.execute("UPDATE assistants SET last_login_at = NOW() WHERE id = $1", asst["id"])
        token = create_token({
            "sub":          str(chosen["client_id"]),
            "email":        asst["email"],
            "role":         "assistant",
            "assistant_id": asst["id"],
            "grant_id":     chosen["grant_id"],
        })
        return {
            "access_token": token,
            "token_type": "bearer",
            "client": {
                "id":    chosen["client_id"],
                "name":  chosen["brand_name"] or chosen["owner_name"],
                "email": data.email,
                "role":  "assistant",
            }
        }

    # Пробуем залогинить как администратора
    admin = await db.fetchrow(
        "SELECT id, name, email, password_hash, is_superadmin FROM admins WHERE LOWER(email) = $1",
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
    email_norm = (data.email or "").strip().lower()
    admin = await db.fetchrow(
        "SELECT id, name, email, password_hash, is_superadmin FROM admins WHERE LOWER(email) = $1",
        email_norm
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
                c.created_at, c.timezone, c.email_verified, c.is_system_service,
                c.test_telegram_ids, c.test_vk_ids, c.test_max_ids, c.test_email_ids, c.work_tg_username, c.work_vk, c.work_max, c.broadcast_concurrency,
                c.notifications_telegram_chat_id, c.notifications_max_chat_id, c.notifications_vk_peer_id, c.notifications_max_url,
                c.partner_landing_url, c.partner_dashboard_url, c.partner_visible_roles,
                c.integration_token, c.default_link_mode,
                c.start_mode, c.start_event_id,
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
    # Роль текущего токена: 'owner' для самого клиента, 'assistant' для ассистента
    # (миграция 105). Используется фронтом для скрытия пунктов меню и DELETE-кнопок.
    out["role"] = "assistant" if payload.get("role") == "assistant" else "owner"
    out["assistant_access_level"] = None
    if out["role"] == "assistant":
        # Подменяем email/имя на email самого ассистента, чтобы в шапке
        # отображался он, а не владелец кабинета.
        out["email"] = payload.get("email") or out.get("email")
        out["assistant_id"] = payload.get("assistant_id")
        # 'full' — права как у владельца (кроме управления помощниками, админки,
        # пароля и email владельца), 'limited' — урезанный набор. Уровень берём из
        # пропуска: в разных кабинетах у помощника могут быть разные права.
        from app.services.assistant_access import is_full_grant_row
        out["assistant_access_level"] = (
            "full" if await is_full_grant_row(db, payload.get("grant_id")) else "limited"
        )
    # VK App ID подключённого Mini App (если есть) — фронт PublicLinks
    # подставляет его в реф-ссылку https://vk.com/app{ID}#ref_pg{slug}.
    # Без него ссылка вела бы на системный 54592404, а не на клиентский.
    from app.services.share_links import get_client_vk_app_id, get_active_platforms, get_client_bot_handles
    out["vk_app_id"] = await get_client_vk_app_id(db, client_id)
    # Handles per-platform: ник клиентского бота/сообщества (или None если у клиента
    # нет своего канала на платформе). Используется UI для построения
    # «ссылок возврата партнёра» (миграция 105) — t.me/{bot}?start=partner_done_{id} и т.п.
    out["bot_handles"] = await get_client_bot_handles(db, client_id)
    # Какие платформы показывать в PublicLinks / RefLinkInline:
    # — ТОЛЬКО те, где у клиента подключён собственный канал (channels.is_system=FALSE).
    # Системные каналы ПЛЮСОНа (@pluson_bot и т.п.) больше не дают ссылок —
    # площадка предлагается клиенту только если он сам её настроил.
    out["available_platforms"] = sorted(set(await get_active_platforms(db, client_id)))
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
    work_vk: Optional[str] = None
    work_max: Optional[str] = None
    broadcast_concurrency: Optional[int] = None
    notifications_telegram_chat_id: Optional[int] = None
    notifications_max_chat_id: Optional[str] = None
    notifications_max_url: Optional[str] = None
    notifications_vk_peer_id: Optional[str] = None
    partner_landing_url: Optional[str] = None
    partner_dashboard_url: Optional[str] = None
    partner_visible_roles: Optional[list[str]] = None


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
                c.test_telegram_ids, c.test_vk_ids, c.test_max_ids, c.test_email_ids, c.work_tg_username, c.work_vk, c.work_max, c.broadcast_concurrency,
                  c.notifications_telegram_chat_id, c.notifications_max_chat_id, c.notifications_vk_peer_id, c.notifications_max_url,
                  c.partner_landing_url, c.partner_dashboard_url, c.partner_visible_roles
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

    # Нормализуем partner_visible_roles — только допустимые ключи ролей.
    if "partner_visible_roles" in updates:
        allowed = {"jury", "speaker", "participant", "organizer", "partner"}
        raw = updates["partner_visible_roles"] or []
        updates["partner_visible_roles"] = [r for r in raw if r in allowed]

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
                  c.test_telegram_ids, c.test_vk_ids, c.test_max_ids, c.test_email_ids, c.work_tg_username, c.work_vk, c.work_max, c.broadcast_concurrency,
                  c.notifications_telegram_chat_id, c.notifications_max_chat_id, c.notifications_vk_peer_id, c.notifications_max_url,
                  c.partner_landing_url, c.partner_dashboard_url, c.partner_visible_roles
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

    Отвечает `found` — есть ли аккаунт с таким email — чтобы страница
    сразу сказала «такой email не зарегистрирован», а человек не ждал
    письма, которого не будет.
    """
    import hashlib
    import secrets
    from datetime import datetime, timedelta

    email_norm = (data.email or "").strip().lower()
    if not email_norm or "@" not in email_norm:
        return {"ok": True, "found": False, "sent": False}

    ip = (request.client.host if request and request.client else "") or ""

    # Ищем сначала среди клиентов, затем среди админов.
    client_row = await db.fetchrow(
        "SELECT id, email FROM clients WHERE LOWER(email) = $1",
        email_norm,
    )
    admin_row = None
    if not client_row:
        admin_row = await db.fetchrow(
            "SELECT id, email FROM admins WHERE LOWER(email) = $1",
            email_norm,
        )

    if not (client_row or admin_row):
        return {"ok": True, "found": False, "sent": False}

    sent = False
    if client_row or admin_row:
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires_at = datetime.utcnow() + timedelta(hours=1)
        to_email = (client_row or admin_row)["email"]

        if client_row:
            await db.execute(
                """INSERT INTO password_reset_tokens
                       (client_id, token_hash, expires_at, ip_address)
                    VALUES ($1, $2, $3, $4)""",
                client_row["id"], token_hash, expires_at, ip[:64],
            )
        else:
            await db.execute(
                """INSERT INTO password_reset_tokens
                       (admin_id, token_hash, expires_at, ip_address)
                    VALUES ($1, $2, $3, $4)""",
                admin_row["id"], token_hash, expires_at, ip[:64],
            )

        # Шлём письмо со ссылкой через системный email-канал ПЛЮСОНа.
        try:
            from app.services.email_sender import EmailSender
            from app.services.unsubscribe_token import make_email_unsubscribe_token
            from app.config import settings as _s

            # Системный email-канал ПЛЮСОНа (is_system=TRUE). Для клиента берём
            # через client_channels (чтобы был client_channel_id для unsub-токена);
            # для админа — сам системный канал напрямую (client_channel_id нет).
            if client_row:
                ch = await db.fetchrow(
                    """SELECT ch.id AS channel_id, cc.id AS client_channel_id,
                              ch.email_subdomain, ch.email_from_local
                         FROM client_channels cc
                         JOIN channels ch ON ch.id = cc.channel_id
                        WHERE cc.client_id = $1
                          AND ch.platform_slug = 'email'
                          AND ch.is_system = TRUE
                        LIMIT 1""",
                    client_row["id"],
                )
                unsub_client_id = client_row["id"]
                unsub_channel_id = ch["client_channel_id"] if ch else 0
            else:
                ch = await db.fetchrow(
                    """SELECT ch.id AS channel_id, NULL::int AS client_channel_id,
                              ch.email_subdomain, ch.email_from_local
                         FROM channels ch
                        WHERE ch.platform_slug = 'email' AND ch.is_system = TRUE
                        LIMIT 1"""
                )
                unsub_client_id = 0
                unsub_channel_id = 0

            if ch:
                reset_url = f"{_s.frontend_url.rstrip('/')}/password-reset/confirm?token={token}"
                channel_dict = dict(ch)
                channel_dict["email_from_name"] = "iViSiON: ПЛЮСОН"

                fake_unsub = make_email_unsubscribe_token(
                    client_id=unsub_client_id, contact_id=0,
                    client_channel_id=unsub_channel_id,
                )

                sender = EmailSender()
                sender.send(
                    channel=channel_dict,
                    client_brand_name="iViSiON: ПЛЮСОН",
                    to_email=to_email,
                    subject="Восстановление пароля — ПЛЮСОН",
                    body_text=(
                        f"Здравствуйте!\n\n"
                        f"Вы запросили восстановление пароля в ПЛЮСОНе.\n\n"
                        f"Перейдите по ссылке, чтобы задать новый пароль:\n"
                        f"{reset_url}\n\n"
                        f"Ссылка действует 1 час. Если вы не запрашивали восстановление — "
                        f"проигнорируйте это письмо.\n\n"
                        f"— Команда ПЛЮСОН"
                    ),
                    unsubscribe_token=fake_unsub,
                )
                sent = True
        except Exception:
            logger.exception("password_reset: не удалось отправить письмо на %s", to_email)

    return {"ok": True, "found": True, "sent": sent}


# ─── Подтверждение email клиента ────────────────────────────────────────


class EmailVerifyConfirm(BaseModel):
    token: str


@router.post("/verify-email/confirm", summary="Подтвердить email по токену")
async def verify_email_confirm(
    data: EmailVerifyConfirm,
    db: asyncpg.Connection = Depends(get_db),
):
    from app.services.email_verification import confirm_verify_token
    ok = await confirm_verify_token(db, data.token)
    if not ok:
        raise HTTPException(status_code=400, detail="Ссылка недействительна или устарела")
    return {"ok": True}


@router.post("/verify-email/resend", summary="Отправить письмо подтверждения email заново")
async def verify_email_resend(
    db: asyncpg.Connection = Depends(get_db),
    credentials=Depends(__import__("app.auth", fromlist=["security"]).security),
):
    from app.auth import decode_token
    if not credentials:
        raise HTTPException(status_code=401, detail="Требуется авторизация")
    payload = decode_token(credentials.credentials)
    # Email владельца — личное: не управляет НИ ОДИН ассистент, даже полный.
    if payload.get("role") == "assistant":
        raise HTTPException(status_code=403, detail="Недоступно для ассистента")
    client_id = int(payload["sub"])

    row = await db.fetchrow("SELECT email_verified FROM clients WHERE id = $1", client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Клиент не найден")
    if row["email_verified"]:
        return {"ok": True, "already_verified": True}

    from app.services.email_verification import send_verification_email
    sent = await send_verification_email(db, client_id)
    return {"ok": True, "sent": sent}


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
        """SELECT id, client_id, admin_id FROM password_reset_tokens
            WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
            LIMIT 1""",
        token_hash,
    )
    if not row:
        raise HTTPException(status_code=400, detail="Ссылка недействительна или устарела")

    new_hash = hash_password(data.new_password)
    async with db.transaction():
        if row["admin_id"] is not None:
            await db.execute(
                "UPDATE admins SET password_hash = $1 WHERE id = $2",
                new_hash, row["admin_id"],
            )
        else:
            await db.execute(
                "UPDATE clients SET password_hash = $1 WHERE id = $2",
                new_hash, row["client_id"],
            )
        await db.execute(
            "UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1",
            row["id"],
        )
    return {"ok": True}
