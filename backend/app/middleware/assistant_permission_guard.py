"""
Middleware: ограничивает действия пользователя с role='assistant'.

⚠️ Два уровня доступа (миграция 208, `client_assistants.access_level`):
  · 'full'    — ассистент = владелец кабинета по правам. Middleware пропускает ВСЁ,
                кроме ЛИЧНОГО владельца (OWNER_ONLY_ALWAYS_*): раздел управления
                ассистентом (иначе сменит себе пароль / удалит себя), админка,
                смена пароля владельца и письмо на его email. Рабочие настройки
                (PATCH /auth/me, каналы, лид-магниты, оплата) — доступны.
  · 'limited' — исторический набор прав, описанный ниже (default).
Уровень читается из БД на каждый запрос ассистента — переключение тумблера
владельцем применяется сразу, без перелогина.

Семантика прав ОГРАНИЧЕННОГО ассистента (фиксировано 2026-05-24):
  ✅ Контакты, коллабораторы, события, участники — читать + править (PATCH/POST/DELETE
     внутри контента: пороги реф-программы, материалы шеринга, шаблоны рассылок,
     шаги nurture, сессии конференции, призы розыгрыша, продукты Mini App, …)
  ✅ Рассылки (общие и в событиях) — полный доступ
  ✅ Mini App (визитка, бренд, основатель, продукты) — полный доступ
  ✅ Реф-программа событий — полный доступ
  ❌ Удаление «человеческих» сущностей и привязок людей к событию:
     · сами контакты, коллабораторы, лид-магниты, подарки события
     · само событие
     · участники события, соорганизаторы события, спикеры конференции
  ❌ Каналы (/api/v1/channels/*) — write запрещён (создавать/править/удалять боты,
     импорт CSV → 403). GET разрешён: список каналов нужен пикерам рассылок.
  ❌ Настройки клиента (/api/v1/auth/me, change-password, regenerate-integration-token,
     ассистенты, юр.данные) — нет доступа
  ❌ Лид-магниты и пакеты — только GET (создавать/править/удалять нельзя)
  ❌ Будущие денежные модули (/api/v1/billing/*, /api/v1/payments/*) — нет доступа

Что пропускается без проверки:
  - GET, OPTIONS, HEAD везде кроме явных «закрытых» путей (channels, settings-эндпоинты)
  - /api/v1/auth/login, /auth/me (GET) — читать профиль владельца можно
  - /api/v1/public/*, /api/v1/integrations/* — публичные webhook'и
"""
import re

from fastapi import Request
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from app.config import settings


# Полностью закрытые префиксы — ни GET, ни write.
FORBIDDEN_PREFIXES = (
    "/api/v1/clients/me/assistant",           # ассистент не управляет сам собой
    "/api/v1/billing",                        # будущие платежи
    "/api/v1/payments",                       # будущие платежи
    "/api/v1/admin",                          # админка отдельно
)

# Только GET разрешён, write-методы → 403.
READONLY_PREFIXES = (
    "/api/v1/lead-magnets",                   # ассистент только смотрит и копирует ссылки
    "/api/v1/lead-magnet-packages",
    # Каналы: ассистент НЕ управляет ботами (создание/правка/удаление/импорт CSV → 403),
    # но GET нужен — список каналов читают пикеры рассылок (выбор каналов отправки).
    # GET /channels не отдаёт bot_token наружу, поэтому read безопасен.
    "/api/v1/channels",
)

# Write-эндпоинты «настроек» — ассистенту запрещены полностью.
FORBIDDEN_WRITE_PATHS = (
    "/api/v1/auth/me",                              # PATCH профиля владельца
    "/api/v1/auth/change-password",                # смена пароля владельца
    "/api/v1/auth/me/regenerate-integration-token",
    "/api/v1/auth/regenerate-integration-token",
)

# Личные учётные данные владельца — закрыты ЛЮБОМУ ассистенту, включая полного.
# Пароль и email — это вход в кабинет, а не рабочий инструмент; ассистент с полным
# доступом не должен уметь сменить их и отрезать владельца от собственного кабинета.
OWNER_ONLY_ALWAYS_PREFIXES = (
    "/api/v1/clients/me/assistant",   # ассистент не управляет сам собой
    "/api/v1/admin",                  # админка платформы
)
# ⚠️ Сюда НЕ входят рабочие эндпоинты, которые полный ассистент использует:
# PATCH /auth/me (имя, часовой пояс, каналы уведомлений, тестовые аккаунты — email
# там не меняется) и перегенерация интеграционного токена.
OWNER_ONLY_ALWAYS_WRITE_PATHS = (
    "/api/v1/auth/change-password",               # пароль владельца — вход в кабинет
    "/api/v1/auth/verify-email/resend",           # письмо на email владельца
)
FORBIDDEN_WRITE_PREFIXES = (
    "/api/v1/clients/me/legal",                    # юр-данные клиента (миграция 099)
)

# DELETE-эндпоинты которые ассистенту запрещены конкретно (всё прочее DELETE
# внутри контента — пороги, материалы, шаблоны, сессии, призы — разрешено).
FORBIDDEN_DELETE_PATTERNS = tuple(
    re.compile(p) for p in (
        # Сами «люди» и подарки/лид-магниты в общей базе клиента
        r"^/api/v1/contacts/\d+(?:/[^/]+)?$",
        r"^/api/v1/collaborators/\d+(?:/[^/]+)?$",
        # Само событие
        r"^/api/v1/events/\d+$",
        # Привязка человека к событию
        r"^/api/v1/events/\d+/participants/\d+$",
        r"^/api/v1/events/\d+/collaborators/\d+$",
        # Подарки события
        r"^/api/v1/events/\d+/gifts/\d+$",
        # Привязка спикера к конференции
        r"^/api/v1/events/\d+/conference/speakers/\d+$",
    )
)

WRITE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}


async def assistant_permission_guard_middleware(request: Request, call_next):
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return await call_next(request)

    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return await call_next(request)

    if payload.get("role") != "assistant":
        return await call_next(request)

    path = request.url.path
    method = request.method.upper()

    # OPTIONS — пропустим для CORS preflight всегда.
    if method == "OPTIONS":
        return await call_next(request)

    # Ассистент с ПОЛНЫМ доступом — прав как у владельца, кроме личного владельца:
    # раздел управления ассистентом (иначе сменит себе пароль / удалит себя),
    # админка, а также email и пароль владельца (вход в кабинет — не рабочий инструмент).
    from app.services.assistant_access import get_assistant_access_level

    level = await get_assistant_access_level(payload.get("assistant_id"))
    # Личное владельца закрыто ЛЮБОМУ ассистенту (проверяем до разбора уровня).
    if any(path.startswith(p) for p in OWNER_ONLY_ALWAYS_PREFIXES):
        return JSONResponse(
            status_code=403,
            content={"detail": "Этот раздел доступен только владельцу кабинета."},
        )
    if method in WRITE_METHODS and path in OWNER_ONLY_ALWAYS_WRITE_PATHS:
        return JSONResponse(
            status_code=403,
            content={"detail": "Email и пароль может менять только владелец кабинета."},
        )

    if level == "full":
        return await call_next(request)

    # 1) Полный запрет по префиксу (любой метод).
    if any(path.startswith(p) for p in FORBIDDEN_PREFIXES):
        return JSONResponse(
            status_code=403,
            content={"detail": "Этот раздел доступен только владельцу кабинета."},
        )

    # 2) Read-only префиксы — запрещаем только write-методы.
    if any(path.startswith(p) for p in READONLY_PREFIXES) and method in WRITE_METHODS:
        return JSONResponse(
            status_code=403,
            content={"detail": "Ассистент может только смотреть этот раздел."},
        )

    # 3) Точечные запрещённые write-эндпоинты.
    if method in WRITE_METHODS:
        if path in FORBIDDEN_WRITE_PATHS or any(
            path.startswith(p) for p in FORBIDDEN_WRITE_PREFIXES
        ):
            return JSONResponse(
                status_code=403,
                content={"detail": "Этот раздел доступен только владельцу кабинета."},
            )

    # 4) Точечный запрет на «опасные» DELETE (люди / событие / привязки людей).
    if method == "DELETE":
        if any(rx.match(path) for rx in FORBIDDEN_DELETE_PATTERNS):
            return JSONResponse(
                status_code=403,
                content={"detail": "Ассистент не может удалять данные. Это действие доступно только владельцу кабинета."},
            )

    return await call_next(request)
