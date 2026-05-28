"""
POST /api/v1/event

Вызывается из Telegram Mini App при открытии события (event_start).
Делегирует логику в `services/event_welcome.send_event_open_message` —
тот же сервис зовётся из `/landing-redirect` (когда у события задан
landing_url и React-bundle Mini App не запускается, см. CLAUDE.md).
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import httpx
import logging
from ..config import settings
from ..database import get_pool
from ..services.channels import get_client_telegram_token
from ..services.event_welcome import send_event_open_message

router = APIRouter()
logger = logging.getLogger(__name__)


class TgEventRequest(BaseModel):
    user_id: str           # ID пользователя на платформе (tg_id / vk_id / max_id)
    event: str             # Тип события: 'event_start'
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    partner_id: str = ""   # промо-партнёр (из startapp pid)
    utm_source: str = ""   # UTM-источник (из startapp src)
    event_slug: str = ""   # slug события (из startapp pg<slug>) — для определения клиента
    client_id: int = 0     # client_id (из startapp cid<id>) — приоритетнее event_slug
    platform: str = "telegram"  # telegram | vk | max — Mini App может крепиться к разным


@router.post("/event")
async def handle_tg_event(body: TgEventRequest):
    """Сигнал от Mini App при открытии события. Шлёт контекстное сообщение через бот клиента."""
    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id required")

    try:
        tg_id = int(body.user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="user_id must be int")

    if body.event != "event_start":
        return {"ok": True}

    if body.platform != "telegram":
        return {"ok": True, "platform": body.platform, "skipped": "no dispatcher"}

    pool = await get_pool()
    if not pool:
        return {"ok": True, "warning": "db not available"}
    if not body.event_slug:
        return {"ok": True, "skipped": "no event_slug"}

    return await send_event_open_message(
        pool,
        tg_id=tg_id,
        event_slug=body.event_slug,
        client_id_hint=body.client_id or 0,
        first_name=body.first_name,
        last_name=body.last_name,
        username=body.username,
        partner_id=body.partner_id,
        utm_source=body.utm_source,
    )


class ShareToBotRequest(BaseModel):
    tg_id: int
    event_slug: str
    text: str | None = None         # legacy: один текст
    texts: list[str] | None = None  # массив текстов (приоритет)


@router.post("/event/share-to-bot")
async def share_to_bot(body: ShareToBotRequest):
    """Mini App → отправить участнику в его бот афиши и готовый текст для шеринга друзьям.

    Шлёт сначала все афиши события (из `event_referral_materials`) — каждую
    отдельным sendPhoto, чтобы человек мог форвардить любую по одной. Потом
    текстом отдельным сообщением. После успешной отправки фронт закрывает
    Mini App (`Telegram.WebApp.close()`).
    """
    # Собираем тексты: приоритет texts[], fallback на text. Игнорим пустые.
    raw_texts: list[str] = list(body.texts or [])
    if not raw_texts and body.text:
        raw_texts = [body.text]
    texts = [t for t in (s.strip() if isinstance(s, str) else "" for s in raw_texts) if t]
    if not texts:
        raise HTTPException(status_code=400, detail="text required")
    if not body.event_slug:
        raise HTTPException(status_code=400, detail="event_slug required")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="db not available")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, client_id FROM events WHERE slug = $1 LIMIT 1",
            body.event_slug,
        )
    if not row:
        raise HTTPException(status_code=404, detail="event not found")
    event_id = row["id"]
    client_id = row["client_id"]

    # Регистрируем пользователя как подписчика главного TG-канала клиента.
    # Mini App может быть открыт минуя /start (через Menu Button) — без этого
    # шага человек никогда не попадёт в platform_user_channels и не будет
    # учтён в счётчике подписчиков канала.
    try:
        from app.services.channels import (
            get_client_telegram_channel_id,
            register_telegram_subscription,
        )
        async with pool.acquire() as conn:
            ch_id = await get_client_telegram_channel_id(client_id, conn)
            if ch_id:
                await register_telegram_subscription(
                    client_id, ch_id, str(tg_id),
                    username=body.username or "",
                    first_name=body.first_name or "",
                    last_name=body.last_name or "",
                    db=conn,
                )
    except Exception as e:
        logger.warning(f"register_telegram_subscription failed: {e}")

    # Афиши для шеринга (event_referral_materials)
    async with pool.acquire() as conn:
        material_rows = await conn.fetch(
            """SELECT image_url FROM event_referral_materials
                WHERE event_id = $1 AND image_url IS NOT NULL AND image_url <> ''
                ORDER BY sort, id""",
            event_id,
        )
    image_urls = [r["image_url"] for r in material_rows]

    bot_token = None
    try:
        async with pool.acquire() as conn:
            bot_token = await get_client_telegram_token(client_id, conn)
    except Exception as e:
        logger.warning(f"get_client_telegram_token failed: {e}")
    if not bot_token:
        bot_token = settings.telegram_bot_token
    if not bot_token:
        raise HTTPException(status_code=500, detail="no bot token configured")

    base = f"https://api.telegram.org/bot{bot_token}"

    try:
        async with httpx.AsyncClient(timeout=15) as http:
            # 1) Афиши — каждая отдельным sendPhoto (по очереди).
            #    Если одна не отправилась — логируем, но идём дальше к тексту.
            for url in image_urls:
                try:
                    r = await http.post(
                        f"{base}/sendPhoto",
                        json={"chat_id": body.tg_id, "photo": url},
                    )
                    if r.status_code != 200:
                        logger.warning(
                            f"share-to-bot photo failed for tg_id={body.tg_id} event={body.event_slug} "
                            f"url={url}: {r.status_code} {r.text[:200]}"
                        )
                except httpx.HTTPError as e:
                    logger.warning(f"share-to-bot photo http error url={url}: {e}")

            # 2) Тексты — каждый отдельным sendMessage, друг за другом, после афиш.
            last_status = 200
            for t in texts:
                r = await http.post(
                    f"{base}/sendMessage",
                    json={
                        "chat_id": body.tg_id,
                        "text": t,
                        "disable_web_page_preview": True,
                    },
                )
                if r.status_code != 200:
                    logger.warning(
                        f"share-to-bot text failed for tg_id={body.tg_id} event={body.event_slug}: "
                        f"{r.status_code} {r.text[:200]}"
                    )
                    last_status = r.status_code
            if last_status != 200:
                raise HTTPException(status_code=502, detail="telegram send failed")
    except httpx.HTTPError as e:
        logger.warning(f"share-to-bot http error for tg_id={body.tg_id}: {e}")
        raise HTTPException(status_code=502, detail="telegram send failed")

    return {"ok": True, "posters_sent": len(image_urls), "texts_sent": len(texts)}


class LinkClickRequest(BaseModel):
    tg_id: int  # legacy название поля; на самом деле — id пользователя на любой платформе
    event_slug: str
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    platform: str = "telegram"  # telegram | vk | max — Mini App один на все платформы


@router.post("/event/link-click")
async def mark_link_click(body: LinkClickRequest):
    """Mini App → отметка, что участник нажал главную CTA-ссылку события
    (у мероприятий и конференций это «Смотреть стрим», у конкурсов —
    «Перейти к голосованию»; адрес у обоих хранится в events.stream_url).

    Пишем первый клик в event_participants.link_clicked_at. Повторные клики
    не перезаписывают (используем COALESCE). Если записи участника ещё нет —
    создаём со статусом interested (is_registered=false) и сразу ставим клик.
    """
    if not body.event_slug:
        raise HTTPException(status_code=400, detail="event_slug required")
    if not body.tg_id:
        raise HTTPException(status_code=400, detail="tg_id required")

    platform = (body.platform or "telegram").lower().strip()
    if platform not in ("telegram", "vk", "max"):
        raise HTTPException(status_code=400, detail="unknown platform")

    pool = await get_pool()
    if not pool:
        raise HTTPException(status_code=500, detail="db not available")

    from app.services.contact_merge import upsert_contact_with_identity

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, client_id FROM events WHERE slug = $1 LIMIT 1",
            body.event_slug,
        )
        if not row:
            raise HTTPException(status_code=404, detail="event not found")
        event_id = row["id"]
        client_id = row["client_id"]

        contact_id, _pu_id, _new = await upsert_contact_with_identity(
            conn,
            client_id=client_id,
            platform_slug=platform,
            platform_user_id=str(body.tg_id),
            username=(body.username.lstrip('@') if body.username else None),
            first_name=body.first_name or None,
            last_name=body.last_name or None,
        )

        await conn.execute(
            """INSERT INTO event_participants (event_id, contact_id, is_registered, link_clicked_at)
               VALUES ($1, $2, FALSE, now())
               ON CONFLICT (event_id, contact_id)
               DO UPDATE SET link_clicked_at = COALESCE(event_participants.link_clicked_at, EXCLUDED.link_clicked_at)""",
            event_id, contact_id,
        )
    return {"ok": True}
