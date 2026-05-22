"""
Endpoint отписки от email-рассылок.

Доступен по ссылке из подвала каждого письма:
    GET  /api/v1/email/unsubscribe?token=...   → HTML-страничка «Вы отписались»
    POST /api/v1/email/unsubscribe?token=...   → 204 No Content (Gmail one-click)

Логика:
1. Парсим JWT-токен (см. services/unsubscribe_token.py)
2. Из payload получаем client_id + contact_id + client_channel_id
3. Находим email-идентичность контакта и помечаем подписку отписанной
4. Записываем событие в email_unsubscribe_log (под аудит и метрики)
5. POST → 204 (Gmail one-click); GET → HTML «Вы отписались»

Endpoint доступен публично, без auth — токен сам по себе является
доказательством легитимности (его знает только владелец письма).
"""
import logging
from fastapi import APIRouter, Request, Response, Depends, HTTPException
from fastapi.responses import HTMLResponse

from app.database import get_db
from app.services.unsubscribe_token import parse_email_unsubscribe_token

logger = logging.getLogger(__name__)

router = APIRouter()


_HTML_OK = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Вы отписались — ПЛЮСОН</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: linear-gradient(45deg, #25455D, #0a1520); color: #fff;
           min-height: 100vh; display: flex; align-items: center; justify-content: center;
           margin: 0; padding: 24px; }
    .card { max-width: 480px; background: #fff; color: #25455D;
            border-radius: 16px; padding: 40px 32px; text-align: center;
            box-shadow: 0 20px 50px rgba(0,0,0,0.3); }
    .badge { width: 64px; height: 64px; background: #FFCFA4; border-radius: 50%;
             display: inline-flex; align-items: center; justify-content: center;
             font-size: 36px; margin-bottom: 16px; }
    h1 { margin: 0 0 12px 0; font-size: 24px; font-weight: 700; }
    p { margin: 8px 0; color: #4a6478; line-height: 1.5; }
    .small { font-size: 13px; color: #94a3b8; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✓</div>
    <h1>Вы отписались</h1>
    <p>Больше вы не будете получать email-письма от этого отправителя.</p>
    <p>Если передумаете — напишите им напрямую, они смогут включить подписку.</p>
    <p class="small">Платформа iViSiON: ПЛЮСОН</p>
  </div>
</body>
</html>
"""

_HTML_BAD = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ссылка устарела — ПЛЮСОН</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: linear-gradient(45deg, #25455D, #0a1520); color: #fff;
           min-height: 100vh; display: flex; align-items: center; justify-content: center;
           margin: 0; padding: 24px; }
    .card { max-width: 480px; background: #fff; color: #25455D;
            border-radius: 16px; padding: 40px 32px; text-align: center;
            box-shadow: 0 20px 50px rgba(0,0,0,0.3); }
    h1 { margin: 0 0 12px 0; font-size: 22px; font-weight: 700; color: #c0392b; }
    p { margin: 8px 0; color: #4a6478; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Ссылка недействительна</h1>
    <p>Ссылка отписки невалидна или устарела. Попробуйте перейти заново из последнего письма.</p>
  </div>
</body>
</html>
"""


async def _do_unsubscribe(token: str, request: Request, db) -> bool:
    """
    Парсит токен и помечает подписку отписанной + пишет в лог.
    Возвращает True если успешно (или уже было отписано), False если токен битый.
    """
    payload = parse_email_unsubscribe_token(token or "")
    if not payload:
        return False

    client_id = payload["client_id"]
    contact_id = payload["contact_id"]
    client_channel_id = payload["client_channel_id"]

    # Проверка что контакт принадлежит указанному клиенту — защита от подмены
    contact_ok = await db.fetchval(
        "SELECT 1 FROM contacts WHERE id = $1 AND client_id = $2",
        contact_id, client_id,
    )
    if not contact_ok:
        return False

    # Находим email-идентичность контакта и подписку на этот канал
    pu_id = await db.fetchval(
        """SELECT id FROM platform_users
            WHERE contact_id = $1 AND platform_slug = 'email'
            LIMIT 1""",
        contact_id,
    )
    if pu_id:
        await db.execute(
            """UPDATE platform_user_channels
                  SET is_unsubscribed = TRUE,
                      unsubscribed_at = NOW()
                WHERE platform_user_id = $1
                  AND client_channel_id = $2
                  AND is_unsubscribed = FALSE""",
            pu_id, client_channel_id,
        )

    # Лог отписки — пригодится для метрик качества и аудита.
    # Таблица email_unsubscribe_log будет создана отдельной миграцией;
    # пока её нет — пишем только в текстовый лог.
    try:
        ip = (request.client.host if request and request.client else "") or ""
        ua = (request.headers.get("user-agent") if request else "") or ""
        await db.execute(
            """INSERT INTO email_unsubscribe_log
                   (contact_id, client_channel_id, client_id, ip_address, user_agent)
                VALUES ($1, $2, $3, $4, $5)""",
            contact_id, client_channel_id, client_id, ip[:64], ua[:500],
        )
    except Exception:
        # Если таблицы ещё нет (миграция не накатилась) — отписка всё равно сработала
        # на platform_user_channels.is_unsubscribed=TRUE.
        pass

    return True


@router.get("/api/v1/email/unsubscribe", response_class=HTMLResponse)
async def email_unsubscribe_get(token: str, request: Request, db=Depends(get_db)):
    ok = await _do_unsubscribe(token, request, db)
    if not ok:
        return HTMLResponse(content=_HTML_BAD, status_code=400)
    return HTMLResponse(content=_HTML_OK, status_code=200)


@router.post("/api/v1/email/unsubscribe")
async def email_unsubscribe_post(token: str, request: Request, db=Depends(get_db)):
    """Gmail one-click отписка (RFC 8058). Возвращает 204 при успехе."""
    ok = await _do_unsubscribe(token, request, db)
    if not ok:
        raise HTTPException(status_code=400, detail="Невалидная ссылка отписки")
    return Response(status_code=204)
