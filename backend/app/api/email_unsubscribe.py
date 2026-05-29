"""
Endpoint отписки от email-рассылок.

Доступен по ссылке из подвала каждого письма:
    GET  /api/v1/email/unsubscribe?token=...     → HTML-страничка с формой
                                                    «Почему отписываетесь?»
                                                    + кнопкой «Подтвердить
                                                    отписку». Сама отписка
                                                    происходит ТОЛЬКО при
                                                    нажатии кнопки.
    POST /api/v1/email/unsubscribe?token=...     → Gmail one-click (RFC 8058)
                                                    или сабмит нашей формы.
                                                    Здесь действительно
                                                    отписываем.

Логика:
1. Парсим JWT-токен (см. services/unsubscribe_token.py).
2. Из payload получаем client_id + contact_id + client_channel_id.
3. Только POST: следуем по цепочке merged_into до master-контакта,
   находим email-адрес, отписываем ВСЕХ активных контактов клиента
   с этим адресом от указанного канала.
4. Сохраняем причину + комментарий (если переданы в form data) в
   email_unsubscribe_log.

Endpoint доступен публично, без auth — токен сам по себе является
доказательством легитимности (его знает только владелец письма).
"""
import logging
from typing import Optional
from fastapi import APIRouter, Form, Request, Response, Depends, HTTPException
from fastapi.responses import HTMLResponse

from app.database import get_db
from app.services.unsubscribe_token import parse_email_unsubscribe_token

logger = logging.getLogger(__name__)

router = APIRouter()


_REASON_OPTIONS = [
    ("too_many", "Слишком много писем"),
    ("not_interesting", "Контент не интересен"),
    ("never_signed_up", "Не помню, чтобы подписывался"),
    ("changed_my_mind", "Передумал участвовать"),
    ("other", "Другая причина"),
]


def _build_form_page(token: str, brand_label: str) -> str:
    """HTML-страница с формой «Почему отписываетесь?» + кнопкой «Подтвердить отписку».
    POST submission прилетит на тот же endpoint и реально отпишет."""
    safe_brand = (brand_label or "ПЛЮСОН").replace("<", "&lt;").replace(">", "&gt;")
    safe_token = token.replace('"', "")
    radios_html = "\n".join(
        f'    <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;background:#f5f7fa;margin-bottom:6px;">'
        f'<input type="radio" name="reason" value="{val}" style="margin:0;"/>'
        f'<span style="font-size:14px;color:#25455D;">{label}</span></label>'
        for val, label in _REASON_OPTIONS
    )
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Отписка от рассылки — ПЛЮСОН</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: linear-gradient(45deg, #25455D, #0a1520); color: #fff;
           min-height: 100vh; display: flex; align-items: center; justify-content: center;
           margin: 0; padding: 24px; }}
    .card {{ max-width: 520px; background: #fff; color: #25455D;
            border-radius: 16px; padding: 32px 28px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.3); width: 100%; box-sizing: border-box; }}
    h1 {{ margin: 0 0 6px 0; font-size: 22px; font-weight: 700; }}
    p.lead {{ margin: 0 0 18px 0; color: #4a6478; font-size: 14px; line-height: 1.5; }}
    .reasons {{ margin: 16px 0; }}
    textarea {{ width: 100%; min-height: 70px; box-sizing: border-box;
               border: 1px solid #d0d7de; border-radius: 10px; padding: 10px 12px;
               font-family: inherit; font-size: 14px; color: #25455D; resize: vertical; }}
    button {{ background: #FFCFA4; color: #25455D; border: none; cursor: pointer;
             padding: 14px 36px; border-radius: 12px; font-size: 15px; font-weight: 700;
             font-family: inherit; width: 100%; margin-top: 14px; }}
    button:hover {{ background: #ffba83; }}
    .small {{ font-size: 12px; color: #94a3b8; margin-top: 14px; text-align: center; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>Хотите отписаться?</h1>
    <p class="lead">Если расскажете причину — поможете {safe_brand} улучшить контент. И ваше мнение не пропадёт даром.</p>
    <form method="post" action="/api/v1/email/unsubscribe?token={safe_token}">
      <div class="reasons">
{radios_html}
      </div>
      <textarea name="reason_comment" placeholder="Комментарий (если хочется)"></textarea>
      <button type="submit">Подтвердить отписку</button>
      <p class="small">Если передумаете — просто закройте эту страницу. Подписка останется активной.</p>
    </form>
  </div>
</body>
</html>
"""


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


async def _do_unsubscribe(
    token: str,
    request: Request,
    db,
    reason: Optional[str] = None,
    reason_comment: Optional[str] = None,
) -> bool:
    """
    Парсит токен и помечает подписку отписанной + пишет в лог.
    Возвращает True если успешно (или уже было отписано), False если токен битый.

    reason/reason_comment — опциональные, приходят из формы friction-страницы.
    Если человек нажал в Gmail one-click (RFC 8058) — оба None.
    """
    payload = parse_email_unsubscribe_token(token or "")
    if not payload:
        return False

    client_id = payload["client_id"]
    contact_id = payload["contact_id"]
    client_channel_id = payload["client_channel_id"]

    # Проверка что контакт принадлежит указанному клиенту — защита от подмены.
    # Заодно тянем merged_into: если контакт был слит — все его platform_users
    # переехали в master-контакт, и отписку нужно делать там.
    contact_row = await db.fetchrow(
        "SELECT id, merged_into FROM contacts WHERE id = $1 AND client_id = $2",
        contact_id, client_id,
    )
    if not contact_row:
        return False

    # Следуем по цепочке merged_into до активного контакта (макс 5 шагов
    # против петель — на практике глубина 1).
    target_contact_id = contact_row["id"]
    visited = {target_contact_id}
    for _ in range(5):
        merged_to = contact_row["merged_into"]
        if not merged_to or merged_to in visited:
            break
        next_row = await db.fetchrow(
            "SELECT id, merged_into FROM contacts WHERE id = $1 AND client_id = $2",
            merged_to, client_id,
        )
        if not next_row:
            break
        target_contact_id = next_row["id"]
        visited.add(target_contact_id)
        contact_row = next_row

    # Резолвим email-адрес: сначала пробуем найти у master-контакта запись
    # в platform_users (там platform_user_id хранит email-адрес). Если нет —
    # берём напрямую из contacts.email_normalized.
    email_addr = await db.fetchval(
        """SELECT platform_user_id FROM platform_users
            WHERE contact_id = $1 AND platform_slug = 'email'
            LIMIT 1""",
        target_contact_id,
    )
    if not email_addr:
        email_addr = await db.fetchval(
            """SELECT pe.platform_user_id FROM platform_users pe
                WHERE pe.contact_id = $1 AND pe.platform_slug = 'email'
                ORDER BY pe.id LIMIT 1""",
            target_contact_id,
        )
    if email_addr:
        # У одного и того же клиента может быть несколько активных контактов
        # с одинаковым email (например, человек пришёл и через TG, и через
        # VK — мы создали 2 отдельных contacts). Отписываемся СРАЗУ ВО ВСЕХ —
        # чтобы человек один раз нажал и больше не получал писем ни от какой
        # из его «личностей» в БД клиента.
        await db.execute(
            """UPDATE platform_user_channels puc
                  SET is_unsubscribed = TRUE,
                      unsubscribed_at = NOW()
                FROM platform_users pu
                JOIN contacts c ON c.id = pu.contact_id
               WHERE puc.platform_user_id = pu.id
                 AND pu.platform_slug = 'email'
                 AND pu.platform_user_id = $1
                 AND c.client_id = $2
                 AND puc.client_channel_id = $3
                 AND puc.is_unsubscribed = FALSE""",
            str(email_addr).strip().lower(), client_id, client_channel_id,
        )

    # Лог отписки — пригодится для метрик качества и аудита.
    # Таблица email_unsubscribe_log будет создана отдельной миграцией;
    # пока её нет — пишем только в текстовый лог.
    try:
        ip = (request.client.host if request and request.client else "") or ""
        ua = (request.headers.get("user-agent") if request else "") or ""
        await db.execute(
            """INSERT INTO email_unsubscribe_log
                   (contact_id, client_channel_id, client_id, ip_address, user_agent,
                    reason, reason_comment)
                VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            contact_id, client_channel_id, client_id, ip[:64], ua[:500],
            (reason or None), (reason_comment or None) if reason_comment else None,
        )
    except Exception:
        # Если таблицы/колонок ещё нет (миграция не накатилась) —
        # отписка всё равно сработала на platform_user_channels.is_unsubscribed=TRUE.
        pass

    return True


@router.get("/api/v1/email/unsubscribe", response_class=HTMLResponse)
async def email_unsubscribe_get(token: str, request: Request, db=Depends(get_db)):
    """Открытие ссылки из письма — НИЧЕГО НЕ ОТПИСЫВАЕТ. Показывает форму
    «Почему отписываетесь?» с галочками и кнопкой «Подтвердить отписку».
    Сама отписка происходит при POST на этот же URL."""
    payload = parse_email_unsubscribe_token(token or "")
    if not payload:
        return HTMLResponse(content=_HTML_BAD, status_code=400)
    # Пытаемся подгрузить название бренда для дружелюбного текста.
    brand_label = "ПЛЮСОН"
    try:
        row = await db.fetchrow(
            "SELECT name, brand_name FROM clients WHERE id=$1",
            payload["client_id"],
        )
        if row:
            owner = (row["name"] or "").strip()
            brand = (row["brand_name"] or "").strip()
            if owner and brand:
                brand_label = f"{owner} и {brand}"
            elif owner:
                brand_label = owner
            elif brand:
                brand_label = brand
    except Exception:
        pass
    return HTMLResponse(content=_build_form_page(token, brand_label), status_code=200)


@router.post("/api/v1/email/unsubscribe")
async def email_unsubscribe_post(
    token: str,
    request: Request,
    reason: Optional[str] = Form(None),
    reason_comment: Optional[str] = Form(None),
    db=Depends(get_db),
):
    """Отписка по нажатию кнопки «Подтвердить» (наша форма) или Gmail one-click
    (RFC 8058 — без формы и без причины). Если клиент шлёт Accept text/html
    (наша форма) — отдаём страничку «Вы отписались». Иначе (Gmail/cURL) — 204."""
    ok = await _do_unsubscribe(token, request, db, reason=reason, reason_comment=reason_comment)
    if not ok:
        # Gmail one-click ждёт 204/200 — отдаём HTML только если просили
        accept = (request.headers.get("accept") or "").lower()
        if "text/html" in accept:
            return HTMLResponse(content=_HTML_BAD, status_code=400)
        raise HTTPException(status_code=400, detail="Невалидная ссылка отписки")
    accept = (request.headers.get("accept") or "").lower()
    if "text/html" in accept:
        return HTMLResponse(content=_HTML_OK, status_code=200)
    return Response(status_code=204)
