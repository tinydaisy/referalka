"""
Публичный API для проверки подписки участника на каналы спикеров/организаторов
события (конференция и мероприятие) при попытке войти в чат события.

GET/POST /api/v1/public/conference/{event_id}/check-subscription?tg_id=...

Логика per канал:
1) Шаг А — VIABILITY: getChatMember(channel, speaker.personal_tg_id).
   Спикер/организатор гарантированно подписан на свой канал. Если ответ ok и
   статус ∈ {creator, administrator, member, restricted} — бот реально админ
   и видит подписки. Иначе (бот не админ / канал недоступен / personal_tg_id
   пустой) — «ложный пропуск», канал кладём в subscribed снизу с галочкой,
   участника не блокируем.
2) Шаг Б — USER CHECK: getChatMember(channel, user_tg_id). Подписан → в
   subscribed, не подписан → в not_subscribed.

`bot_in_channel` в БД — диагностический флаг для дашборда клиента, к рантайм-
логике не относится: проверяем «вживую» каждый раз. Если спикер случайно убрал
бота из админов — мы автоматически перестанем требовать его канал у участников,
а вернёт админа — снова подключим. Никаких ручных пере-нажиманий.

Ответ:
{
  "status": 1 | 0,                       // 1 если not_subscribed пустой
  "not_subscribed": [{...}],             // показывать наверху (требует подписки)
  "subscribed":     [{...}],             // показывать внизу с галочкой (включая ложные пропуски)
  "not_subscribed_text": "имя: url\n..." // legacy-поле для текстового вывода
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


_SUBSCRIBED_STATUSES = ("member", "administrator", "creator", "restricted")


async def _get_chat_member(client: httpx.AsyncClient, token: str, channel_id: str, user_id: int) -> tuple[bool, str]:
    """Возвращает (ok, status). ok=False означает что Telegram не дал данных
    (бот не админ / канал недоступен / сетевой сбой). status — пустая строка
    при ok=False, иначе строка от Telegram."""
    try:
        r = await client.get(
            f"https://api.telegram.org/bot{token}/getChatMember",
            params={"chat_id": channel_id, "user_id": user_id},
            timeout=5.0,
        )
        data = r.json()
        if not data.get("ok"):
            return False, ""
        status = (data.get("result") or {}).get("status") or ""
        return True, status
    except Exception:
        return False, ""


async def _check_one_channel(
    http: httpx.AsyncClient,
    token: str,
    channel_id: str,
    speaker_personal_tg_id: int | None,
    user_tg_id: int,
) -> str:
    """Возвращает одну из меток: 'subscribed' | 'not_subscribed' | 'fake_pass'.

    fake_pass — бот не видит канал, пропускаем участника без проверки.
    """
    if not speaker_personal_tg_id:
        # Без personal_tg_id не можем подтвердить, что бот реально админ →
        # проверять участника бесполезно (любой ответ Telegram неоднозначен).
        return "fake_pass"

    viability_ok, speaker_status = await _get_chat_member(http, token, channel_id, int(speaker_personal_tg_id))
    if not viability_ok or speaker_status not in _SUBSCRIBED_STATUSES:
        # Бот не админ / удалён / канал недоступен / спикер сам отписался от канала.
        # Пропускаем участника, не блокируем из-за чужой ошибки.
        return "fake_pass"

    user_ok, user_status = await _get_chat_member(http, token, channel_id, user_tg_id)
    if user_ok and user_status in _SUBSCRIBED_STATUSES:
        return "subscribed"
    return "not_subscribed"


async def _do_check(event_id: int, tg_id: int, db: asyncpg.Connection):
    event = await db.fetchrow(
        "SELECT id, (SELECT eo.client_id FROM event_owners eo WHERE eo.event_id=events.id AND eo.status='accepted' ORDER BY (eo.role='owner') DESC, eo.id LIMIT 1) AS client_id, require_subscription FROM events WHERE id = $1", event_id
    )
    if not event:
        return {"status": 0, "not_subscribed": [], "subscribed": [], "not_subscribed_text": ""}

    # Режим подписки задаётся в настройках:
    #   Конференция (есть запись в conf_conferences):
    #     subscription_mode: none / organizer / all_speakers
    #   Мероприятие (нет conf_conferences):
    #     events.require_subscription: false → none, true → organizer
    conf = await db.fetchrow(
        "SELECT subscription_mode FROM conf_conferences WHERE event_id = $1", event_id
    )
    if conf:
        mode = dict(conf).get("subscription_mode") or "all_speakers"
    else:
        mode = "organizer" if event["require_subscription"] else "none"

    if mode == "none":
        return {"status": 1, "not_subscribed": [], "subscribed": [], "not_subscribed_text": ""}

    role_filter = "AND cse.role = 'organizer'" if mode == "organizer" else ""

    # Сортировка как у конференций — сначала priority (меньше = выше),
    # потом sort_order, потом id для устойчивости.
    rows = await db.fetch(
        f"""SELECT sp.id AS speaker_id, sp.name, sp.tg_channel_id, sp.tg_channel_url,
                   pu_tg.platform_user_id AS personal_tg_id,
                   cse.priority, cse.sort_order
           FROM event_collaborators cse
           JOIN collaborators sp ON sp.id = cse.speaker_id
           LEFT JOIN platform_users pu_tg
             ON pu_tg.contact_id = sp.contact_id AND pu_tg.platform_slug = 'telegram'
           WHERE cse.event_id = $1
             AND cse.exclude_channel_from_subscription = FALSE
             AND sp.tg_channel_id IS NOT NULL
             AND sp.tg_channel_id <> ''
             {role_filter}
           ORDER BY COALESCE(cse.priority, 60), cse.sort_order, cse.id""",
        event["id"],
    )

    if not rows:
        return {"status": 1, "not_subscribed": [], "subscribed": [], "not_subscribed_text": ""}

    from app.services.channels import get_client_telegram_token
    token = await get_client_telegram_token(event["client_id"], db)
    if not token:
        token = settings.telegram_bot_token
    if not token:
        return {"status": 0, "not_subscribed": [], "subscribed": [], "not_subscribed_text": ""}

    speakers = [dict(r) for r in rows]

    async with httpx.AsyncClient() as http:
        verdicts = await asyncio.gather(
            *(
                _check_one_channel(http, token, sp["tg_channel_id"], sp.get("personal_tg_id"), tg_id)
                for sp in speakers
            )
        )

    not_subscribed: list[dict] = []
    subscribed: list[dict] = []
    for sp, verdict in zip(speakers, verdicts):
        item = {
            "speaker_id": sp["speaker_id"],
            "name": sp["name"],
            "tg_channel_id": sp["tg_channel_id"],
            "tg_channel_url": sp["tg_channel_url"],
        }
        if verdict == "not_subscribed":
            not_subscribed.append(item)
        else:
            # subscribed | fake_pass — оба идут вниз с галочкой
            subscribed.append(item)

    not_subscribed_text = "\n".join(
        f"{sp['name']}: {sp['tg_channel_url'] or sp['tg_channel_id']}"
        for sp in not_subscribed
    )

    return {
        "status": 0 if not_subscribed else 1,
        "not_subscribed": not_subscribed,
        "subscribed": subscribed,
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
