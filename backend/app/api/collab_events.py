"""
Коллаборации: запросы (серый→зелёный), co-ownership совместных событий, умный сват, отзывы.

Поток (см. documentation/CONCEPT-COLLAB-NETWORK.md §9):
1. Клиент 1 из Хаба жмёт «Предложить коллаборацию» (опц. к своему событию) → hub_collab_requests (pending=серый).
2. Клиент 2 видит входящий запрос → Принять/Отклонить.
3. Принял → event_owners(event_id, client_2, accepted, co_owner). Событие становится коллаб (is_collab=TRUE).
   Реф-ссылка клиента 2 на событие создаётся (его вклад считается). Молчун — висит серым, не участвует.
4. Активно, если подтвердил ≥1. Реф-ссылки только подтвердившим.

Защита: в коллаб-событии нельзя удалять участников / менять рефоводов (см. middleware/правила — на уровне API).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
from app.api.collab_hub import require_collab_hub
import asyncpg

router = APIRouter(prefix="/collab", tags=["Коллаборации"],
                   dependencies=[Depends(require_collab_hub)])


async def _client_telegram(db, client_id: int) -> Optional[str]:
    """TG-ник клиента для кнопки «Написать в Telegram» (из platform_users или telegram_username)."""
    row = await db.fetchrow("SELECT telegram_username FROM clients WHERE id=$1", client_id)
    return row["telegram_username"] if row else None


# ═══════════════════════════════════════════════════════════════
# Запросы на коллаборацию
# ═══════════════════════════════════════════════════════════════
class CollabRequestIn(BaseModel):
    to_client_id: int           # кому предлагаем (created_by_client_id из карточки каталога)
    event_id: Optional[int] = None   # к какому СВОЕМУ событию (опц.)
    message: Optional[str] = None


@router.post("/requests")
async def create_request(data: CollabRequestIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Отправить запрос на коллаборацию. У инициатора будет «серым», пока не ответят."""
    me = int(client["sub"])
    if data.to_client_id == me:
        raise HTTPException(400, "Нельзя пригласить самого себя")
    # если к событию — проверяем что событие моё (я владелец)
    if data.event_id:
        owns = await db.fetchval(
            "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'",
            data.event_id, me)
        if not owns:
            # fallback на старое поле events.client_id
            owns = await db.fetchval("SELECT 1 FROM events WHERE id=$1 AND client_id=$2", data.event_id, me)
        if not owns:
            raise HTTPException(403, "Это не ваше событие")
    # не плодим дубль pending к тому же человеку по тому же событию
    dup = await db.fetchval(
        """SELECT id FROM hub_collab_requests
            WHERE from_client_id=$1 AND to_client_id=$2 AND status='pending'
              AND (event_id=$3 OR ($3 IS NULL AND event_id IS NULL))""",
        me, data.to_client_id, data.event_id)
    if dup:
        raise HTTPException(409, "Запрос уже отправлен и ждёт ответа")
    rid = await db.fetchval(
        """INSERT INTO hub_collab_requests (from_client_id, to_client_id, event_id, message)
           VALUES ($1,$2,$3,$4) RETURNING id""",
        me, data.to_client_id, data.event_id, data.message)
    return {"ok": True, "request_id": rid}


@router.get("/requests")
async def list_requests(direction: str = "incoming", client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """direction=incoming (входящие мне) | outgoing (мои отправленные, в т.ч. серые)."""
    me = int(client["sub"])
    if direction == "outgoing":
        rows = await db.fetch(
            """SELECT r.id, r.to_client_id AS other_client_id, COALESCE(tc.brand_name,tc.name) AS other_name,
                      COALESCE(tc.owner_photo_url,tc.profile_photo_url) AS other_photo,
                      tc.is_published_in_hub AS other_published,
                      tc.telegram_username AS other_tg, r.event_id, e.title AS event_title,
                      r.status, r.message, r.created_at
                 FROM hub_collab_requests r
                 LEFT JOIN clients tc ON tc.id=r.to_client_id
                 LEFT JOIN events e ON e.id=r.event_id
                WHERE r.from_client_id=$1 ORDER BY r.created_at DESC""", me)
    else:
        rows = await db.fetch(
            """SELECT r.id, r.from_client_id AS other_client_id, COALESCE(fc.brand_name,fc.name) AS other_name,
                      COALESCE(fc.owner_photo_url,fc.profile_photo_url) AS other_photo,
                      fc.is_published_in_hub AS other_published,
                      fc.telegram_username AS other_tg, r.event_id, e.title AS event_title,
                      r.status, r.message, r.created_at
                 FROM hub_collab_requests r
                 LEFT JOIN clients fc ON fc.id=r.from_client_id
                 LEFT JOIN events e ON e.id=r.event_id
                WHERE r.to_client_id=$1 ORDER BY r.created_at DESC""", me)
    return {"requests": [dict(r) for r in rows], "direction": direction}


@router.post("/requests/{request_id}/respond")
async def respond_request(request_id: int, body: dict, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Принять/отклонить входящий запрос. accept=true → стать co_owner события (если запрос к событию)."""
    me = int(client["sub"])
    accept = bool(body.get("accept"))
    req = await db.fetchrow("SELECT * FROM hub_collab_requests WHERE id=$1", request_id)
    if not req or req["to_client_id"] != me:
        raise HTTPException(404, "Запрос не найден")
    if req["status"] != "pending":
        raise HTTPException(409, "Запрос уже обработан")
    new_status = "accepted" if accept else "declined"
    await db.execute(
        "UPDATE hub_collab_requests SET status=$2, responded_at=NOW() WHERE id=$1",
        request_id, new_status)
    if accept and req["event_id"]:
        # добавляем меня как co_owner события → событие становится коллаб
        await db.execute(
            """INSERT INTO event_owners (event_id, client_id, status, role, invited_by_client_id, responded_at)
               VALUES ($1,$2,'accepted','co_owner',$3,NOW())
               ON CONFLICT (event_id, client_id) DO UPDATE SET status='accepted', responded_at=NOW()""",
            req["event_id"], me, req["from_client_id"])
        await db.execute("UPDATE events SET is_collab=TRUE WHERE id=$1", req["event_id"])
    return {"ok": True, "status": new_status}


# ═══════════════════════════════════════════════════════════════
# Владельцы (Организаторы) события
# ═══════════════════════════════════════════════════════════════
@router.get("/events/{event_id}/owners")
async def event_owners(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Организаторы события (статусы серый/зелёный). Видит любой из владельцев."""
    me = int(client["sub"])
    iam = await db.fetchval(
        "SELECT 1 FROM event_owners WHERE event_id=$1 AND client_id=$2", event_id, me)
    if not iam:
        iam = await db.fetchval("SELECT 1 FROM events WHERE id=$1 AND client_id=$2", event_id, me)
    if not iam:
        raise HTTPException(403, "Вы не организатор этого события")
    rows = await db.fetch(
        """SELECT o.client_id, c.name, c.telegram_username, o.status, o.role, o.created_at, o.responded_at
             FROM event_owners o LEFT JOIN clients c ON c.id=o.client_id
            WHERE o.event_id=$1 ORDER BY o.role='owner' DESC, o.created_at""", event_id)
    return {"owners": [dict(r) for r in rows]}


# ═══════════════════════════════════════════════════════════════
# Умный сват — подбор партнёра по нише + медийность + рейтинг
# ═══════════════════════════════════════════════════════════════
@router.get("/matchmaker")
async def matchmaker(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Подбор 3-5 партнёров-организаторов: моя ниша → близкие, лучше рейтинг. Не я. Данные из clients."""
    me = int(client["sub"])
    mine = await db.fetchrow("SELECT hub_niche, hub_city FROM clients WHERE id=$1", me)
    niche = mine["hub_niche"] if mine else None
    rows = await db.fetch(
        """SELECT cl.id AS client_id, COALESCE(cl.brand_name,cl.name) AS name,
                  COALESCE(cl.owner_photo_url,cl.profile_photo_url) AS photo_url,
                  cl.hub_category, cl.hub_niche, cl.hub_city, cl.media_assets,
                  (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=cl.id) AS collabs_count,
                  (cl.hub_niche IS NOT DISTINCT FROM $2) AS same_niche
             FROM clients cl
            WHERE cl.is_published_in_hub=TRUE AND cl.id<>$1
            ORDER BY (cl.hub_niche IS NOT DISTINCT FROM $2) DESC, collabs_count DESC NULLS LAST, cl.hub_published_at DESC NULLS LAST
            LIMIT 5""", me, niche)
    out = []
    for r in rows:
        d = dict(r)
        d['media_tier'] = _media_tier_from(d.pop('media_assets', None))
        out.append(d)
    return {"my_niche": niche, "suggestions": out}


def _media_tier_from(ma) -> str:
    import json as _j
    try:
        arr = ma if isinstance(ma, list) else (_j.loads(ma) if ma else [])
        s = sum(int(a.get('subscribers') or 0) for a in arr if isinstance(a, dict))
    except Exception:
        s = 0
    return 'over_10k' if s>=10000 else '5k_10k' if s>=5000 else '1k_5k' if s>=1000 else 'under_1k'


# ═══════════════════════════════════════════════════════════════
# Отзывы
# ═══════════════════════════════════════════════════════════════
class ReviewIn(BaseModel):
    client_id: int    # о ком
    rating: int
    text: Optional[str] = None


@router.post("/reviews")
async def add_review(data: ReviewIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    me = int(client["sub"])
    if data.client_id == me:
        raise HTTPException(400, "Нельзя оставить отзыв самому себе")
    if not (1 <= data.rating <= 5):
        raise HTTPException(400, "Оценка 1..5")
    await db.execute(
        """INSERT INTO hub_reviews (client_id, author_client_id, rating, text)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (client_id, author_client_id)
           DO UPDATE SET rating=$3, text=$4, created_at=NOW()""",
        data.client_id, me, data.rating, data.text)
    return {"ok": True}
