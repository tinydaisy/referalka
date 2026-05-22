"""
Tracking endpoints для аналитики email-рассылок:
- /api/v1/email/pixel/{token}.gif — открытия писем (1x1 прозрачный gif)
- /api/v1/email/click?token=...&u=... — клики по ссылкам (302-редирект)

Токены — JWT с {kind, blid (broadcast_log_id), co (contact_id)}.
Без срока жизни (письма открываются и через год).

ВАЖНО: пиксель и ссылки вставляются в HTML-версию писем в email_sender.
Пока email_sender отправляет plain-text — pixel/click не вшивается, и эта
аналитика тихо ничем не показывает. Это нормально для MVP; станет рабочей
с появлением HTML-вёрстки писем.

Apple Mail Privacy Protection с 2021 года автоматически открывает все письма
у себя (выпускает open даже если пользователь не открывал). Поэтому open rate
от Apple-юзеров завышен на 30-50%. Учитываем при анализе.
"""
import time
import base64
import urllib.parse
import logging
from typing import Optional
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from jose import jwt, JWTError

from app.database import get_db
from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


_KIND_OPEN = "em_open"
_KIND_CLICK = "em_click"
_ALG = "HS256"


def make_open_token(broadcast_log_id: int, contact_id: int) -> str:
    return jwt.encode(
        {"kind": _KIND_OPEN, "blid": broadcast_log_id, "co": contact_id, "iat": int(time.time())},
        settings.jwt_secret, algorithm=_ALG,
    )


def make_click_token(broadcast_log_id: int, contact_id: int) -> str:
    return jwt.encode(
        {"kind": _KIND_CLICK, "blid": broadcast_log_id, "co": contact_id, "iat": int(time.time())},
        settings.jwt_secret, algorithm=_ALG,
    )


def _decode(token: str, kind: str) -> Optional[dict]:
    try:
        p = jwt.decode(token, settings.jwt_secret, algorithms=[_ALG])
    except (JWTError, Exception):
        return None
    if p.get("kind") != kind:
        return None
    return p


# 1x1 прозрачный GIF (base64)
_PIXEL_BYTES = base64.b64decode(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
)


@router.get("/api/v1/email/pixel/{token}.gif")
async def email_open_pixel(token: str, request: Request, db=Depends(get_db)):
    """Tracking pixel — открытие письма. Всегда отдаёт 1x1 gif (даже если токен битый)."""
    payload = _decode(token, _KIND_OPEN)
    if payload:
        try:
            blid = int(payload.get("blid", 0))
            co = int(payload.get("co", 0))
            client_id = await db.fetchval("SELECT client_id FROM contacts WHERE id = $1", co)
            ip = (request.client.host if request and request.client else "")[:64]
            ua = (request.headers.get("user-agent") or "")[:500]
            await db.execute(
                """INSERT INTO email_open_log
                       (broadcast_log_id, contact_id, client_id, ip_address, user_agent)
                    VALUES ($1, $2, $3, $4, $5)""",
                blid or None, co or None, client_id, ip, ua,
            )
        except Exception as e:
            logger.warning(f"email_open log failed: {e}")
    return Response(
        content=_PIXEL_BYTES,
        media_type="image/gif",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


@router.get("/api/v1/email/click")
async def email_click_redirect(
    token: str,
    u: str,           # целевой URL
    request: Request,
    db=Depends(get_db),
):
    """Click tracking — переписанная ссылка из письма. 302 на оригинал."""
    target_url = urllib.parse.unquote(u)
    payload = _decode(token, _KIND_CLICK)
    if payload:
        try:
            blid = int(payload.get("blid", 0))
            co = int(payload.get("co", 0))
            client_id = await db.fetchval("SELECT client_id FROM contacts WHERE id = $1", co)
            ip = (request.client.host if request and request.client else "")[:64]
            ua = (request.headers.get("user-agent") or "")[:500]
            await db.execute(
                """INSERT INTO email_click_log
                       (broadcast_log_id, contact_id, client_id,
                        target_url, ip_address, user_agent)
                    VALUES ($1, $2, $3, $4, $5, $6)""",
                blid or None, co or None, client_id,
                target_url[:2000], ip, ua,
            )
        except Exception as e:
            logger.warning(f"email_click log failed: {e}")
    # Если URL невалидный — возвращаем на главную ПЛЮСОНа
    if not target_url.startswith(("http://", "https://")):
        target_url = "https://pluson.ru/"
    return RedirectResponse(url=target_url, status_code=302)
