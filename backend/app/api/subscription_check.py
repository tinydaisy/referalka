"""
Публичный API для проверки подписки участника на каналы спикеров конференции.

Используется из Salebot: отдать один HTTP-запрос вместо 20 отдельных tg_get_chat_member.
Бэкенд сам делает getChatMember в канал каждого спикера, у которого установлена галочка
"Добавил бота в канал" (conf_speaker_events.bot_in_channel = TRUE), и возвращает 1 или 0.

Возвращает plain text "1" если участник подписан на ВСЕ такие каналы, иначе "0".
"""
import asyncio
import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from app.config import settings
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/api/v1/public", tags=["Публичные API"])


async def _check_member(client: httpx.AsyncClient, token: str, channel_id: str, user_id: int) -> bool:
    """
    Вызывает getChatMember. Возвращает True, если пользователь состоит в канале
    (status: member/administrator/creator/restricted). False — если left/kicked или ошибка API.
    """
    try:
        r = await client.get(
            f"https://api.telegram.org/bot{token}/getChatMember",
            params={"chat_id": channel_id, "user_id": user_id},
            timeout=5.0,
        )
        data = r.json()
        if not data.get("ok"):
            return False
        status = (data.get("result") or {}).get("status")
        return status in ("member", "administrator", "creator", "restricted")
    except Exception:
        return False


@router.get(
    "/conference/{event_slug}/check-subscription",
    response_class=PlainTextResponse,
    summary="Проверить подписку участника на каналы спикеров конференции",
)
async def check_conference_subscription(
    event_slug: str,
    tg_id: int = Query(..., description="Telegram user id участника (platform_id в Salebot)"),
    db: asyncpg.Connection = Depends(get_db),
) -> str:
    event = await db.fetchrow(
        "SELECT id, client_id FROM events WHERE slug = $1", event_slug
    )
    if not event:
        return "0"

    rows = await db.fetch(
        """SELECT sp.tg_channel_id
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
             AND cse.bot_in_channel = TRUE
             AND sp.tg_channel_id IS NOT NULL
             AND sp.tg_channel_id <> ''""",
        event["id"],
    )

    channel_ids = [r["tg_channel_id"] for r in rows]
    if not channel_ids:
        return "1"

    client_row = await db.fetchrow(
        "SELECT bot_token FROM clients WHERE id = $1", event["client_id"]
    )
    token = (client_row["bot_token"] or "").strip() if client_row else ""
    if not token:
        token = settings.telegram_bot_token
    if not token:
        return "0"

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            *(_check_member(client, token, ch, tg_id) for ch in channel_ids)
        )

    return "1" if all(results) else "0"
