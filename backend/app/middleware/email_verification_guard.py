"""
Middleware: блокирует write-операции по РАССЫЛКАМ, если email клиента
не подтверждён.

Заблокирована именно ОТПРАВКА/постановка рассылок в очередь (защита от
спама с фейкового аккаунта) — write по путям с сегментом /broadcasts/schedules:
  - /api/v1/broadcasts/schedules*          — общие рассылки клиента
  - .../broadcasts/schedules*              — событийные рассылки

Настройка шаблонов (.../broadcasts/templates) НЕ блокируется — это
конфигурация, а не отправка. Всё остальное (события, контакты, воронки
лид-магнитов, настройки) тоже работает — воронки специально НЕ блокируются
(решение пользователя от 2026-07-02).

Поведение:
  - GET/OPTIONS/HEAD — всегда пропускаются (просмотр очереди рассылок ОК).
  - Путь не про рассылки — пропускаем.
  - Без Authorization / невалидный JWT / role=admin — пропускаем.
  - Ассистент (role=assistant) — пропускаем (это кабинет владельца, email его,
    ассистент не виноват; при этом плашка ассистенту не показывается).
  - Клиент с email_verified=FALSE на write по рассылкам → 403.
"""
from fastapi import Request
from fastapi.responses import JSONResponse
from jose import JWTError, jwt
from app.config import settings


SAFE_METHODS = {"GET", "OPTIONS", "HEAD"}


def _is_broadcast_write_path(path: str) -> bool:
    # Только постановка/запуск рассылок — сегмент /broadcasts/schedules.
    # Общие: /api/v1/broadcasts/schedules...
    # Событийные: /api/v1/events/{id}/broadcasts/schedules...
    # Шаблоны (/broadcasts/templates) сюда НЕ попадают — их настройка разрешена.
    return path.startswith("/api/v1/") and "/broadcasts/schedules" in path


async def email_verification_guard_middleware(request: Request, call_next):
    if request.method in SAFE_METHODS:
        return await call_next(request)

    path = request.url.path
    if not _is_broadcast_write_path(path):
        return await call_next(request)

    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return await call_next(request)

    token = auth_header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return await call_next(request)

    role = payload.get("role")
    if role in ("admin", "assistant"):
        return await call_next(request)

    sub = payload.get("sub")
    if not sub:
        return await call_next(request)
    try:
        client_id = int(sub)
    except (TypeError, ValueError):
        return await call_next(request)

    from app.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as db:
        verified = await db.fetchval(
            "SELECT email_verified FROM clients WHERE id = $1", client_id
        )

    if verified is False:
        return JSONResponse(
            status_code=403,
            content={"detail": "Подтвердите email, чтобы запускать рассылки. "
                               "Мы отправили письмо на вашу почту — проверьте её (и папку «Спам»)."},
        )

    return await call_next(request)
