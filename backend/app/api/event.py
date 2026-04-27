"""
POST /api/v1/event

Вызывается из Telegram Mini App при первом открытии (event_start).
Отправляет участнику приветственное сообщение через бот клиента
(если у клиента есть активный telegram-канал в channels). Если нет —
fallback на общего @pluson_bot.

Вызывается из mini-app/src/App.tsx функцией sendTgEvent().

История:
- 2026-04-27: переключено на get_client_telegram_token (бот клиента из channels)
- 2026-04-27: убран код для telegram_users (таблица удалена в миграции 036)
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import httpx
import logging
from ..config import settings
from ..database import get_pool
from ..services.channels import get_client_telegram_token

router = APIRouter()
logger = logging.getLogger(__name__)


class TgEventRequest(BaseModel):
    user_id: str           # Telegram ID пользователя
    event: str             # Тип события: 'event_start'
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    partner_id: str = ""   # промо-партнёр (из startapp pid)
    event_slug: str = ""   # slug события (из startapp pg<slug>) — для определения клиента
    client_id: int = 0     # client_id (из startapp cid<id>) — приоритетнее event_slug


@router.post("/event")
async def handle_tg_event(body: TgEventRequest):
    """Получает сигнал от Mini App при открытии. При event_start шлёт приветствие через бот клиента."""
    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id required")

    try:
        tg_id = int(body.user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="user_id must be int")

    if body.event != "event_start":
        return {"ok": True}

    # Определяем client_id для выбора бота
    pool = await get_pool()
    client_id = body.client_id or 0

    if not client_id and body.event_slug and pool:
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT client_id FROM events WHERE slug = $1 LIMIT 1",
                    body.event_slug,
                )
                if row:
                    client_id = row["client_id"]
        except Exception as e:
            logger.warning(f"event lookup by slug failed: {e}")

    # Берём токен бота клиента, иначе fallback на общего
    bot_token = None
    if client_id and pool:
        try:
            async with pool.acquire() as conn:
                bot_token = await get_client_telegram_token(client_id, conn)
        except Exception as e:
            logger.warning(f"get_client_telegram_token failed: {e}")

    if not bot_token:
        bot_token = settings.telegram_bot_token

    if not bot_token:
        return {"ok": True, "warning": "no bot token configured"}

    # Текст приветствия
    name = body.first_name or "друг"
    text = (
        f"Привет, {name}! 👋\n\n"
        "Добро пожаловать. Открой мини-приложение чтобы увидеть свои события и подарки 🎁"
    )

    try:
        async with httpx.AsyncClient(timeout=5) as http:
            await http.post(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                json={"chat_id": tg_id, "text": text},
            )
    except Exception as e:
        logger.warning(f"sendMessage failed for {tg_id}: {e}")

    return {"ok": True, "client_id": client_id}
