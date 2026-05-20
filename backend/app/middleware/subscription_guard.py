"""
Middleware: блокирует write-операции (POST/PATCH/PUT/DELETE) если у клиента
нет активной подписки. GET всегда пропускает (просмотр интерфейса разрешён даже
при истёкшей подписке).

Истёкшая подписка → 403 «Подписка истекла, продлите тариф для возобновления работы.»

Что пропускается без проверки:
  - /api/v1/auth/*       — login/register/me
  - /api/v1/admin/*      — админ работает по другой авторизации
  - /api/v1/public/*     — публичные эндпоинты Mini App / лендингов
  - /api/v1/integrations/* — webhook'и от GetCourse/Salebot (внешние)
  - /api/v1/event        — POST event_start от Mini App (это участник, не клиент)
  - /api/v1/participants/* — действия участников Mini App
  - /api/v1/referral/conversion — webhook конверсий
  - /r/, /m/, /p/        — лендинги/воронки

Поведение:
  - GET, OPTIONS, HEAD — всегда пропускаются.
  - Без Authorization header — пропускаем (auth-зависимый эндпоинт сам вернёт 401).
  - JWT с role='admin' — пропускаем.
  - Пользовательский JWT + истёкшая подписка → 403.
"""
from fastapi import Request
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from app.config import settings


SAFE_METHODS = {"GET", "OPTIONS", "HEAD"}

PASSTHROUGH_PREFIXES = (
    "/api/v1/auth/",
    "/api/v1/admin/",
    "/api/v1/public/",
    "/api/v1/integrations/",
    "/api/v1/participants",
    "/api/v1/event",  # POST event_start, share-to-bot — действия участника, не клиента
    "/api/v1/vk/",    # VK Mini App callbacks + webhook
    "/api/v1/max/",   # MAX Mini App callbacks + webhook
    "/api/v1/referral",
    "/r/",
    "/m/",
    "/p/",
    "/health",
)


async def subscription_guard_middleware(request: Request, call_next):
    if request.method in SAFE_METHODS:
        return await call_next(request)

    path = request.url.path
    if any(path.startswith(p) for p in PASSTHROUGH_PREFIXES):
        return await call_next(request)

    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return await call_next(request)

    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return await call_next(request)

    if payload.get("role") == "admin":
        return await call_next(request)

    sub = payload.get("sub")
    if not sub:
        return await call_next(request)

    try:
        client_id = int(sub)
    except (TypeError, ValueError):
        return await call_next(request)

    # Проверка подписки
    from app.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as db:
        is_active = await db.fetchval(
            """SELECT 1 FROM client_subscriptions
                WHERE client_id = $1 AND status = 'active' AND expires_at > NOW()
                LIMIT 1""",
            client_id,
        )

    if not is_active:
        return JSONResponse(
            status_code=403,
            content={"detail": "Подписка истекла. Продлите тариф для возобновления работы."},
        )

    return await call_next(request)
