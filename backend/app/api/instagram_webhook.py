"""
Приём вебхуков Meta: комментарии под публикациями и сообщения в директ.

⚠️⚠️ У Meta ОДИН вебхук на всё приложение — в отличие от MAX, где у каждого
бота свой адрес. Все клиенты приходят на этот URL, и клиент определяется по
`entry[].id` (это ig_user_id) → канал → владелец канала.

⚠️⚠️ Отвечаем 200 СРАЗУ, обработку уносим в фон. Meta считает медленный ответ
сбоем и после серии неудач отключает вебхук — молча, и воронка перестаёт
работать у всех клиентов разом.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging

from fastapi import APIRouter, BackgroundTasks, Request, Response

from ..config import settings
from ..database import get_pool

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/instagram", tags=["instagram"])


@router.get("/webhook", include_in_schema=False)
async def verify(request: Request):
    """Проверка адреса при подключении вебхука в кабинете Meta."""
    q = request.query_params
    if q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == _verify_token():
        return Response(content=q.get("hub.challenge") or "", media_type="text/plain")
    return Response(content="forbidden", status_code=403, media_type="text/plain")


def _verify_token() -> str:
    """Слово, которым Meta подтверждает адрес.

    ⚠️ Отдельной переменной не заводим: у нас уже есть секрет приложения, и
    ещё один секрет — ещё одно место, где он разъедется между сервером и
    кабинетом Meta. Берём производную от app_secret.
    """
    return hashlib.sha256(
        f"plusson-ig-{settings.ig_app_secret}".encode()
    ).hexdigest()[:32]


def _signature_ok(body: bytes, header: str | None) -> bool:
    """Подпись запроса.

    ⚠️⚠️ Без проверки любой желающий может слать нам поддельные комментарии и
    вытаскивать материалы клиентов — знать нужно только адрес вебхука, а он
    публичный. Поэтому неподписанный запрос отбрасываем всегда.
    """
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(
        settings.ig_app_secret.encode(), body, hashlib.sha256
    ).hexdigest()
    # ⚠️ Сравнение в постоянное время: обычное `==` подсказывает подбирающему,
    # сколько символов уже угадано.
    return hmac.compare_digest(expected, header.split("=", 1)[1])


@router.post("/webhook", include_in_schema=False)
async def receive(request: Request, background: BackgroundTasks):
    body = await request.body()
    if not _signature_ok(body, request.headers.get("X-Hub-Signature-256")):
        log.warning("Instagram webhook: неверная подпись")
        return Response(content="bad signature", status_code=403, media_type="text/plain")

    try:
        payload = json.loads(body)
    except Exception:
        return Response(content="EVENT_RECEIVED", media_type="text/plain")

    # ⚠️ Разбор — в фоне. Ответ Meta должен уйти немедленно.
    background.add_task(_process, payload)
    return Response(content="EVENT_RECEIVED", media_type="text/plain")


async def _process(payload: dict) -> None:
    """Разобрать событие и передать в движок воронки."""
    from ..services import instagram_funnel as funnel

    pool = await get_pool()
    async with pool.acquire() as db:
        for entry in (payload.get("entry") or []):
            ig_user_id = str(entry.get("id") or "")
            if not ig_user_id:
                continue

            ch = await db.fetchrow(
                """SELECT id FROM channels
                    WHERE platform_slug='instagram'
                      AND platform_meta->>'ig_user_id' = $1""",
                ig_user_id,
            )
            if not ch:
                # Чужой аккаунт или канал уже отключили — это не ошибка.
                continue
            channel_id = ch["id"]

            # Комментарии
            for ch_item in (entry.get("changes") or []):
                if ch_item.get("field") != "comments":
                    continue
                v = ch_item.get("value") or {}
                frm = v.get("from") or {}
                sender = str(frm.get("id") or "")
                # ⚠️ Свои же комментарии пропускаем: иначе ответ бота под
                # публикацией снова прилетит вебхуком и запустит воронку на
                # самих себя — бесконечный круг.
                if not sender or sender == ig_user_id:
                    continue
                media = (v.get("media") or {}).get("id") or ""
                try:
                    await funnel.handle_comment(
                        db, channel_id,
                        comment_id=str(v.get("id") or ""),
                        media_id=str(media),
                        text=v.get("text") or "",
                        from_igsid=sender,
                        from_username=frm.get("username") or "",
                    )
                except Exception:
                    log.exception("Instagram: обработка комментария сорвалась")

            # Сообщения в директ
            for m in (entry.get("messaging") or []):
                sender = str((m.get("sender") or {}).get("id") or "")
                if not sender or sender == ig_user_id:
                    continue
                # ⚠️ Эхо собственных отправок Meta присылает тем же событием —
                # без этой проверки бот отвечал бы сам себе.
                if (m.get("message") or {}).get("is_echo"):
                    continue
                text = (m.get("message") or {}).get("text") or ""
                try:
                    await funnel.handle_message(
                        db, channel_id, from_igsid=sender, text=text
                    )
                except Exception:
                    log.exception("Instagram: обработка сообщения сорвалась")
