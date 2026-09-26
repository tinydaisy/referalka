"""Приём входящего письма от Postfix (миграция 521).

`POST /api/v1/internal/inbound-email` — тело = сырое письмо (RFC 822).
Зовёт ТОЛЬКО pipe-скрипт Postfix `deploy/mail_inbound.sh` на этом же сервере.

⚠️ Две защиты сразу: запрос только с 127.0.0.1 И общий секрет
`INBOUND_EMAIL_TOKEN` (env). Одной адресной проверки мало: запрос пришёл бы
«с localhost» и через nginx, если его однажды проксируют сюда.

⚠️ Ошибка обработки → 500 → скрипт возвращает Postfix «временная ошибка», и
тот повторит доставку позже. Письмо не теряется, пока API лежит. Повтор не
плодит дубли: сообщение уникально по Message-ID.
"""
from __future__ import annotations

import hmac
import logging
import os

from fastapi import APIRouter, HTTPException, Request

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/internal", tags=["Внутреннее: входящая почта"])

MAX_RAW_BYTES = 30 * 1024 * 1024


@router.post("/inbound-email", include_in_schema=False)
async def inbound_email(request: Request):
    token = (os.getenv("INBOUND_EMAIL_TOKEN") or "").strip()
    got = request.headers.get("X-Inbound-Token") or ""
    host = request.client.host if request.client else ""
    if not token or host not in ("127.0.0.1", "::1") or not hmac.compare_digest(token, got):
        raise HTTPException(403, "forbidden")

    raw = await request.body()
    if not raw:
        raise HTTPException(400, "empty")
    if len(raw) > MAX_RAW_BYTES:
        # ⚠️ 413, а не 500: повторять доставку бессмысленно — письмо не уменьшится.
        raise HTTPException(413, "too large")

    from app.services.email_inbound import process_inbound
    try:
        return await process_inbound(raw)
    except Exception:
        log.exception("inbound email: обработка упала")
        raise HTTPException(500, "processing failed")
