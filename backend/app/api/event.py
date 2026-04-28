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
import time
from ..config import settings
from ..database import get_pool
from ..services.channels import get_client_telegram_token
from ..services.contact_merge import upsert_contact_with_identity

router = APIRouter()
logger = logging.getLogger(__name__)

# Дедуп приветствий: фронт шлёт event_start дважды (сразу + после
# requestWriteAccess), чтобы охватить и существующих, и новых юзеров.
# Чтобы существующий не получил приветствие два раза подряд — держим
# 5-минутное in-memory окно по ключу (tg_id, event_slug).
_WELCOME_TTL_SEC = 300
_welcome_sent: dict[tuple[int, str], float] = {}

def _was_welcomed(tg_id: int, slug: str) -> bool:
    now = time.time()
    # лёгкая чистка протухших
    if len(_welcome_sent) > 1000:
        for k, t in list(_welcome_sent.items()):
            if now - t > _WELCOME_TTL_SEC:
                _welcome_sent.pop(k, None)
    last = _welcome_sent.get((tg_id, slug))
    if last and now - last < _WELCOME_TTL_SEC:
        return True
    _welcome_sent[(tg_id, slug)] = now
    return False


class TgEventRequest(BaseModel):
    user_id: str           # ID пользователя на платформе (tg_id / vk_id / max_id)
    event: str             # Тип события: 'event_start'
    first_name: str = ""
    last_name: str = ""
    username: str = ""
    partner_id: str = ""   # промо-партнёр (из startapp pid)
    event_slug: str = ""   # slug события (из startapp pg<slug>) — для определения клиента
    client_id: int = 0     # client_id (из startapp cid<id>) — приоритетнее event_slug
    platform: str = "telegram"  # telegram | vk | max — Mini App может крепиться к разным


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

    # Пока приветствие в ЛС умеет только Telegram. Для VK/MAX этот хендлер
    # принимает событие, но не пытается достучаться до канала — диспетчер
    # допишется когда подключим соответствующий SDK на фронте.
    if body.platform != "telegram":
        return {"ok": True, "platform": body.platform, "skipped": "no dispatcher"}

    # Дедуп: фронт шлёт event_start дважды (сразу + после requestWriteAccess).
    # Если уже слали приветствие этому tg_id за последние 5 минут — пропускаем.
    if _was_welcomed(tg_id, body.event_slug or ""):
        return {"ok": True, "deduped": True}

    # Определяем event_id и client_id (из slug или явного client_id)
    pool = await get_pool()
    client_id = body.client_id or 0
    event_id: int | None = None

    if body.event_slug and pool:
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT id, client_id FROM events WHERE slug = $1 LIMIT 1",
                    body.event_slug,
                )
                if row:
                    event_id = row["id"]
                    if not client_id:
                        client_id = row["client_id"]
        except Exception as e:
            logger.warning(f"event lookup by slug failed: {e}")

    # Если знаем и событие, и клиента — фиксируем «интересовался»: создаём
    # contact + event_participants с is_registered=false. Если запись уже
    # есть — ничего не трогаем (форма регистрации сама поднимет флаг).
    # Это нужно чтобы статус в селекторе/хабе менялся `new` → `interested`
    # когда человек открыл событие через Mini App, но до формы не дошёл.
    if event_id and client_id and pool:
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    contact_id, _pu_id, _is_new = await upsert_contact_with_identity(
                        conn,
                        client_id=client_id,
                        platform_slug='telegram',
                        platform_user_id=str(tg_id),
                        username=body.username or None,
                        first_name=body.first_name or None,
                        last_name=body.last_name or None,
                    )
                    await conn.execute(
                        """INSERT INTO event_participants (event_id, contact_id, is_registered)
                                VALUES ($1, $2, FALSE)
                           ON CONFLICT DO NOTHING""",
                        event_id, contact_id,
                    )
        except Exception as e:
            logger.warning(f"interested upsert failed for tg_id={tg_id} event_slug={body.event_slug}: {e}")

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
