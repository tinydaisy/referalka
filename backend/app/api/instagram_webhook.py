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
        log.warning("Instagram webhook: заголовка подписи нет вовсе (header=%r)", header)
        return False
    expected = hmac.new(
        settings.ig_app_secret.encode(), body, hashlib.sha256
    ).hexdigest()
    got = header.split("=", 1)[1]
    # ⚠️ Сравнение в постоянное время: обычное `==` подсказывает подбирающему,
    # сколько символов уже угадано.
    if hmac.compare_digest(expected, got):
        return True

    # ⚠️ Расхождение подписи диагностировать вслепую невозможно: причин
    # несколько (не тот секрет, изменённое посредником тело, другая кодировка),
    # а снаружи все они выглядят одинаково — «403 и тишина». Поэтому пишем в
    # лог НАЧАЛА обеих подписей и длину тела.
    #
    # ⚠️ Сам секрет в лог не попадает: подпись его не раскрывает, а по первым
    # символам видно, сходится она или нет. Логи читают люди, которым доступ к
    # ключам приложения не нужен.
    log.warning(
        "Instagram webhook: подпись не сошлась. ждали sha256=%s…, пришло sha256=%s…, тело %d байт",
        expected[:12], got[:12], len(body),
    )
    return False


@router.post("/webhook", include_in_schema=False)
async def receive(request: Request, background: BackgroundTasks):
    body = await request.body()
    if not _signature_ok(body, request.headers.get("X-Hub-Signature-256")):
        # ⚠️ Тело отвергнутого события — в лог. Запрос при этом всё равно
        # отбрасывается: защита не ослаблена, но по одной лишь строке «подпись
        # не сошлась» невозможно понять, ЧТО именно прислали — событие нашего
        # аккаунта, чужого приложения или проверочный образец Meta.
        log.warning(
            "Instagram webhook ОТВЕРГНУТ: %s",
            body.decode("utf-8", "replace")[:800],
        )
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

    # ⚠️ Сырое событие в лог: имена полей у Meta различаются между способами
    # подписки и меняются со временем. Без записи разбирать пришлось бы
    # вслепую, гоняя человека писать комментарии по десять раз.
    log.info("Instagram webhook: %s", json.dumps(payload, ensure_ascii=False)[:1200])

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
            #
            # ⚠️⚠️ Поле называется по-РАЗНОМУ в зависимости от того, как
            # подписана страница: документация Meta говорит `comments`, но при
            # подписке страницы Facebook принимается только `feed` — проверено
            # живым запросом 2026-09-07. Принимаем оба: имена у Meta меняются,
            # а пропущенное событие выглядит как «воронка не работает».
            for ch_item in (entry.get("changes") or []):
                if ch_item.get("field") not in ("comments", "feed"):
                    continue
                v = ch_item.get("value") or {}
                # ⚠️ В `feed` приходят ВСЕ события ленты — публикации, лайки,
                # реакции. Нам нужны только комментарии.
                if ch_item.get("field") == "feed" and v.get("item") not in (None, "comment"):
                    continue
                frm = v.get("from") or {}
                sender = str(frm.get("id") or "")
                # ⚠️ Свои же комментарии пропускаем: иначе ответ бота под
                # публикацией снова прилетит вебхуком и запустит воронку на
                # самих себя — бесконечный круг.
                if not sender or sender == ig_user_id:
                    continue
                # ⚠️ Поля различаются: в `comments` публикация лежит в
                # media.id и текст в text; в `feed` — post_id и message.
                media = (v.get("media") or {}).get("id") or v.get("post_id") or v.get("media_id") or ""
                comment_id = str(v.get("comment_id") or v.get("id") or "")
                text = v.get("text") or v.get("message") or ""
                try:
                    await funnel.handle_comment(
                        db, channel_id,
                        comment_id=comment_id,
                        media_id=str(media),
                        text=text,
                        from_igsid=sender,
                        from_username=frm.get("username") or frm.get("name") or "",
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
                        db, channel_id, from_igsid=sender, text=text,
                        message_id=str((m.get("message") or {}).get("mid") or ""),
                    )
                except Exception:
                    log.exception("Instagram: обработка сообщения сорвалась")
