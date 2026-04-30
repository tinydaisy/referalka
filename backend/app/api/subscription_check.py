"""
Публичный API для проверки подписки участника на каналы спикеров конференции.

POST /api/v1/public/conference/{event_id}/check-subscription
Body: {"tg_id": 5725111966}

Ответ JSON:
{
  "status": 1,          // 1 — подписан на всё, 0 — не подписан на что-то
  "not_subscribed": [   // список каналов, на которые НЕ подписан (пустой если status=1)
    {
      "speaker_id": 4,
      "name": "Рамиля Шиманская",
      "tg_channel_id": "-1002161199761",
      "tg_channel_url": "https://t.me/..."
    }
  ]
}
"""
import asyncio
import httpx
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from app.config import settings
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/api/v1/public", tags=["Публичные API"])


class SubscriptionCheckBody(BaseModel):
    tg_id: str

    def tg_id_int(self) -> int:
        return int(self.tg_id)


async def _check_member(client: httpx.AsyncClient, token: str, channel_id: str, user_id: int) -> bool:
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


async def _do_check(event_id: int, tg_id: int, db: asyncpg.Connection):
    event = await db.fetchrow(
        "SELECT id, client_id FROM events WHERE id = $1", event_id
    )
    if not event:
        return {"status": 0, "not_subscribed": []}

    # Режим подписки задаётся в настройках конференции:
    #   none          — проверка не требуется (status всегда 1)
    #   organizer     — только канал организатора (role = 'organizer')
    #   all_speakers  — все спикеры (текущий дефолт)
    conf = await db.fetchrow(
        "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id
    )
    mode = (dict(conf).get("subscription_mode") if conf else None) or "all_speakers"
    if mode == "none":
        return {"status": 1, "not_subscribed": []}

    role_filter = "AND cse.role = 'organizer'" if mode == "organizer" else ""

    rows = await db.fetch(
        f"""SELECT sp.id AS speaker_id, sp.name, sp.tg_channel_id, sp.tg_channel_url
           FROM conf_speaker_events cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           WHERE cse.event_id = $1
             AND cse.bot_in_channel = TRUE
             AND cse.exclude_channel_from_subscription = FALSE
             AND sp.tg_channel_id IS NOT NULL
             AND sp.tg_channel_id <> ''
             {role_filter}""",
        event["id"],
    )

    if not rows:
        return {"status": 1, "not_subscribed": []}

    from app.services.channels import get_client_telegram_token
    token = await get_client_telegram_token(event["client_id"], db)
    if not token:
        token = settings.telegram_bot_token
    if not token:
        return {"status": 0, "not_subscribed": []}

    speakers = [dict(r) for r in rows]

    async with httpx.AsyncClient() as http:
        results = await asyncio.gather(
            *(_check_member(http, token, sp["tg_channel_id"], tg_id) for sp in speakers)
        )

    not_subscribed = [
        {
            "speaker_id": sp["speaker_id"],
            "name": sp["name"],
            "tg_channel_id": sp["tg_channel_id"],
            "tg_channel_url": sp["tg_channel_url"],
        }
        for sp, subscribed in zip(speakers, results)
        if not subscribed
    ]

    not_subscribed_text = "\n".join(
        f"{sp['name']}: {sp['tg_channel_url'] or sp['tg_channel_id']}"
        for sp in not_subscribed
    )

    return {
        "status": 0 if not_subscribed else 1,
        "status_zaglushka": 1,
        "not_subscribed": not_subscribed,
        "not_subscribed_text": not_subscribed_text,
    }


@router.get(
    "/conference/{event_id}/check-subscription",
    summary="Проверить подписку (GET) — все параметры в URL",
)
async def check_subscription_get(
    event_id: int,
    tg_id: str = Query(...),
    db: asyncpg.Connection = Depends(get_db),
):
    return await _do_check(event_id, int(tg_id), db)


@router.post(
    "/conference/{event_id}/check-subscription",
    summary="Проверить подписку (POST)",
)
async def check_subscription_post(
    event_id: int,
    body: SubscriptionCheckBody,
    db: asyncpg.Connection = Depends(get_db),
):
    return await _do_check(event_id, body.tg_id_int(), db)
