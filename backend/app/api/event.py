"""
POST /api/v1/event

Вызывается из Telegram Mini App при первом открытии (event_start).
Регистрирует или обновляет пользователя в telegram_users
и отправляет ему приветственное сообщение через бота.

Вызывается из mini-app/src/App.tsx функцией sendTgEvent().
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import httpx
import logging
from ..config import settings

router = APIRouter()
logger = logging.getLogger(__name__)


class TgEventRequest(BaseModel):
    user_id: str         # Telegram ID пользователя
    event: str           # Тип события: 'event_start'
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    partner_id: str = ""  # промо-партнёр (из startapp pid)


@router.post("/event")
async def handle_tg_event(body: TgEventRequest):
    """
    Получает сигнал от Mini App при открытии.
    Сохраняет/обновляет пользователя в telegram_users.
    При event_start отправляет приветственное сообщение.
    """
    if not body.user_id:
        raise HTTPException(status_code=400, detail="user_id required")

    tg_id = int(body.user_id)

    # Upsert пользователя в telegram_users
    try:
        from ..database import get_pool
        pool = await get_pool()
        if pool:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO telegram_users (tg_id, username, first_name)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (tg_id) DO UPDATE
                      SET username   = EXCLUDED.username,
                          first_name = EXCLUDED.first_name
                    """,
                    tg_id, body.username or None, body.first_name or None,
                )
    except Exception as e:
        logger.warning(f"telegram_users upsert failed: {e}")

    # Отправляем приветственное сообщение
    if body.event == "event_start" and settings.telegram_bot_token:
        name = body.first_name or "друг"
        text = (
            f"Привет, {name}! 👋\n\n"
            "Добро пожаловать в ПЛЮСОН — здесь ты можешь участвовать в реферальной игре "
            "и получать подарки за приглашение друзей.\n\n"
            "Открой мини-приложение чтобы увидеть свой прогресс 🎁"
        )
        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
                    json={"chat_id": tg_id, "text": text},
                    timeout=5,
                )
        except Exception as e:
            # Не критично — если не отправилось, продолжаем
            logger.warning(f"sendMessage failed for {tg_id}: {e}")

    return {"ok": True}
