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
            raise HTTPException(403, "Это не ваше событие")
    # не плодим дубль pending к тому же человеку по тому же событию
    dup = await db.fetchval(
        """SELECT id FROM hub_collab_requests
            WHERE from_client_id=$1 AND to_client_id=$2 AND status='pending'
              AND (event_id=$3 OR ($3 IS NULL AND event_id IS NULL))""",
        me, data.to_client_id, data.event_id)
    if dup:
        raise HTTPException(409, "Запрос уже отправлен и ждёт ответа")
    # event_id опционален: NULL → коллаба-событие создастся ТОЛЬКО при принятии (не плодим пустые события).
    # event_id задан → присоединяем партнёра к существующей коллабе.
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


def _surname(name):
    if not name: return "?"
    parts = name.strip().split()
    return parts[-1] if parts else name

import secrets as _secrets
_SLUG_AB = '23456789abcdefghjkmnpqrstuvwxyz'
async def _make_collab_slug(db):
    while True:
        s = ''.join(_secrets.choice(_SLUG_AB) for _ in range(6))
        if not await db.fetchval("SELECT 1 FROM events WHERE slug=$1", s):
            return s


@router.post("/requests/{request_id}/respond")
async def respond_request(request_id: int, body: dict, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Принять/отклонить запрос. accept=true:
      - есть event_id → присоединяю партнёра к существующей коллабе (co_owner).
      - нет event_id → СОЗДАЮ коллабу-событие (название из фамилий). Пустые события заранее НЕ плодим."""
    me = int(client["sub"])
    accept = bool(body.get("accept"))
    req = await db.fetchrow("SELECT * FROM hub_collab_requests WHERE id=$1", request_id)
    if not req or req["to_client_id"] != me:
        raise HTTPException(404, "Запрос не найден")
    if req["status"] != "pending":
        raise HTTPException(409, "Запрос уже обработан")
    new_status = "accepted" if accept else "declined"
    created_event_id = None
    async with db.transaction():
        await db.execute("UPDATE hub_collab_requests SET status=$2, responded_at=NOW() WHERE id=$1", request_id, new_status)
        if accept:
            initiator, acceptor = req["from_client_id"], req["to_client_id"]
            if req["event_id"]:
                ev = await db.fetchrow("SELECT client_id FROM event_owners WHERE event_id=$1 AND status='accepted' ORDER BY (role='owner') DESC, id LIMIT 1", req["event_id"])
                owner_cid = ev["client_id"] if ev else None
                partner_cid = initiator if owner_cid == acceptor else acceptor
                if partner_cid and partner_cid != owner_cid:
                    await db.execute(
                        """INSERT INTO event_owners (event_id, client_id, status, role, invited_by_client_id, responded_at)
                           VALUES ($1,$2,'accepted','co_owner',$3,NOW())
                           ON CONFLICT (event_id, client_id) DO UPDATE SET status='accepted', role='co_owner', responded_at=NOW()""",
                        req["event_id"], partner_cid, owner_cid)
                await db.execute("UPDATE events SET is_collab=TRUE WHERE id=$1", req["event_id"])
                created_event_id = req["event_id"]
            else:
                names = await db.fetch("SELECT id, COALESCE(brand_name,name) AS name FROM clients WHERE id=ANY($1)", [initiator, acceptor])
                nm = {r["id"]: r["name"] for r in names}
                title = f"{_surname(nm.get(initiator))} · {_surname(nm.get(acceptor))}"
                slug = await _make_collab_slug(db)
                ev = await db.fetchrow(
                    "INSERT INTO events (slug, title, module_slug, status, is_collab) VALUES ($1,$2,'base','draft',TRUE) RETURNING id",
                    slug, title)
                created_event_id = ev["id"]
                await db.execute("INSERT INTO event_owners (event_id, client_id, status, role) VALUES ($1,$2,'accepted','owner') ON CONFLICT DO NOTHING", created_event_id, initiator)
                await db.execute(
                    """INSERT INTO event_owners (event_id, client_id, status, role, invited_by_client_id, responded_at)
                       VALUES ($1,$2,'accepted','co_owner',$3,NOW()) ON CONFLICT (event_id, client_id) DO NOTHING""",
                    created_event_id, acceptor, initiator)
                await db.execute("UPDATE hub_collab_requests SET event_id=$2 WHERE id=$1", request_id, created_event_id)
    return {"ok": True, "status": new_status, "event_id": created_event_id}


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
        raise HTTPException(403, "Вы не организатор этого события")
    rows = await db.fetch(
        """SELECT o.client_id, c.name, c.telegram_username, o.status, o.role, o.created_at, o.responded_at
             FROM event_owners o LEFT JOIN clients c ON c.id=o.client_id
            WHERE o.event_id=$1 ORDER BY o.role='owner' DESC, o.created_at""", event_id)
    return {"owners": [dict(r) for r in rows]}


# ═══════════════════════════════════════════════════════════════
# Коллабы — список совместных событий, где я владелец (с ФИО организаторов)
# ═══════════════════════════════════════════════════════════════
@router.get("/collabs")
async def my_collabs(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Мои коллабы (совместные события). С названием и ФИО всех организаторов."""
    me = int(client["sub"])
    rows = await db.fetch(
        """SELECT e.id AS event_id, e.title, e.status, e.is_collab,
                  (SELECT json_agg(json_build_object('client_id', o2.client_id,
                          'name', COALESCE(c2.brand_name,c2.name), 'role', o2.role)
                          ORDER BY (o2.role='owner') DESC, o2.id)
                     FROM event_owners o2 JOIN clients c2 ON c2.id=o2.client_id
                    WHERE o2.event_id=e.id AND o2.status='accepted') AS organizers
             FROM events e
             JOIN event_owners o ON o.event_id=e.id AND o.client_id=$1 AND o.status='accepted'
            WHERE e.is_collab=TRUE
            ORDER BY e.created_at DESC""", me)
    import json as _json
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("organizers"), str):
            try: d["organizers"] = _json.loads(d["organizers"])
            except Exception: d["organizers"] = []
        out.append(d)
    return {"collabs": out}


# ═══════════════════════════════════════════════════════════════
# Отзыв согласия — выйти из коллабы
# ═══════════════════════════════════════════════════════════════
@router.post("/events/{event_id}/leave")
async def leave_collab(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Отозвать согласие / выйти из коллабы. Owner (создатель) выйти не может — он распускает коллабу удалением события."""
    me = int(client["sub"])
    row = await db.fetchrow("SELECT role FROM event_owners WHERE event_id=$1 AND client_id=$2 AND status='accepted'", event_id, me)
    if not row:
        raise HTTPException(404, "Вы не участник этой коллабы")
    if row["role"] == 'owner':
        raise HTTPException(403, "Вы создатель коллабы — чтобы распустить, удалите событие. Выйти может только присоединившийся.")
    await db.execute("DELETE FROM event_owners WHERE event_id=$1 AND client_id=$2", event_id, me)
    # если остался 1 владелец — событие перестаёт быть коллабой
    cnt = await db.fetchval("SELECT count(*) FROM event_owners WHERE event_id=$1 AND status='accepted'", event_id)
    if (cnt or 0) <= 1:
        await db.execute("UPDATE events SET is_collab=FALSE WHERE id=$1", event_id)
    return {"ok": True}


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
