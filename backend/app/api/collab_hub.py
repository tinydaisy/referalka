"""
Коллабораторная (Хаб) — биржа коллабораций между клиентами ПЛЮСОНа.

Слои (см. documentation/CONCEPT-COLLAB-NETWORK.md):
- Карточка клиента в Хабе (публикация себя через collaborators.is_published_in_hub + категория/ниша).
- Открытый каталог Хаба (поиск партнёров по нише/категории/медийности/гео).
- Рейтинг клиента (кол-во коллабораций + средний % вклада живых).
- Умный сват (подбор партнёра по нише + размер аудитории + рейтинг).
- Запросы на коллаборацию (серый→зелёный) + co-ownership совместных событий (event_owners).
- Отзывы.

Термины: ВЛАДЕЛЬЦЫ совместного события = «Организаторы» (event_owners, клиенты-совладельцы).
Внутренние спикеры/жюри = «коллабораторы» (event_collaborators) — другой слой, не путать.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/collab-hub", tags=["Коллабораторная (Хаб)"])

HUB_CATEGORIES = ['offline_business', 'online_business', 'freelancer', 'expert']


def _media_tier(total_subs: int) -> str:
    """Ярлык медийности из суммы подписчиков по media_assets."""
    if total_subs >= 10000:
        return 'over_10k'
    if total_subs >= 5000:
        return '5k_10k'
    if total_subs >= 1000:
        return '1k_5k'
    return 'under_1k'


def _sum_subscribers(media_assets) -> int:
    if not media_assets:
        return 0
    try:
        import json
        arr = media_assets if isinstance(media_assets, list) else json.loads(media_assets)
        return sum(int(a.get('subscribers') or 0) for a in arr if isinstance(a, dict))
    except Exception:
        return 0


# ═══════════════════════════════════════════════════════════════
# Справочник ниш
# ═══════════════════════════════════════════════════════════════
@router.get("/niches")
async def list_niches(db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch("SELECT slug, title FROM hub_niches ORDER BY sort_order, title")
    return {"niches": [dict(r) for r in rows]}


# ═══════════════════════════════════════════════════════════════
# Моя карточка в Хабе — публикация себя
# ═══════════════════════════════════════════════════════════════
class HubCardIn(BaseModel):
    collaborator_id: int          # какую collaborators-карточку публикуем как «себя»
    is_published_in_hub: bool = True
    hub_category: Optional[str] = None
    hub_niche: Optional[str] = None
    hub_city: Optional[str] = None
    hub_about: Optional[str] = None


async def _my_published_collaborator(db, client_id: int):
    """Карточка коллаборатора, которой клиент представляет себя в Хабе (created_by_client_id = он, published)."""
    return await db.fetchrow(
        """SELECT c.*,
                  (SELECT count(*) FROM collaborator_posters cp WHERE cp.collaborator_id=c.id) AS posters_count
             FROM collaborators c
            WHERE c.created_by_client_id=$1 AND c.is_published_in_hub=TRUE
            ORDER BY c.hub_published_at DESC NULLS LAST, c.id DESC LIMIT 1""",
        client_id
    )


@router.get("/me/card")
async def get_my_card(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Моя опубликованная карточка + список моих коллабораторов (чтобы выбрать, кого опубликовать как себя)."""
    published = await _my_published_collaborator(db, int(client["sub"]))
    mine = await db.fetch(
        """SELECT id, name, title, photo_url, is_published_in_hub, hub_category, hub_niche, hub_city, hub_about, media_assets
             FROM collaborators WHERE created_by_client_id=$1 ORDER BY id DESC""",
        int(client["sub"])
    )
    def card(r):
        d = dict(r)
        d['media_tier'] = _media_tier(_sum_subscribers(d.get('media_assets')))
        return d
    return {
        "published": card(published) if published else None,
        "my_collaborators": [card(r) for r in mine],
    }


@router.post("/me/card")
async def publish_my_card(data: HubCardIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Опубликовать/обновить свою карточку в Хабе. Никакой новой сущности — флаг на collaborators."""
    if data.hub_category and data.hub_category not in HUB_CATEGORIES:
        raise HTTPException(400, "Неизвестная категория")
    col = await db.fetchrow(
        "SELECT id, created_by_client_id FROM collaborators WHERE id=$1", data.collaborator_id
    )
    if not col or col["created_by_client_id"] != int(client["sub"]):
        raise HTTPException(403, "Это не ваша карточка коллаборатора")
    await db.execute(
        """UPDATE collaborators
              SET is_published_in_hub=$2, hub_category=$3, hub_niche=$4, hub_city=$5, hub_about=$6,
                  hub_published_at=CASE WHEN $2 AND hub_published_at IS NULL THEN NOW() ELSE hub_published_at END,
                  updated_at=NOW()
            WHERE id=$1""",
        data.collaborator_id, data.is_published_in_hub, data.hub_category,
        data.hub_niche, data.hub_city, data.hub_about
    )
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# Каталог Хаба — поиск партнёров
# ═══════════════════════════════════════════════════════════════
@router.get("/catalog")
async def catalog(
    niche: Optional[str] = None,
    category: Optional[str] = None,
    media_tier: Optional[str] = None,
    city: Optional[str] = None,
    q: Optional[str] = None,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    """Открытый каталог опубликованных коллабораторов (клиентов ПЛЮСОНа)."""
    where = ["c.is_published_in_hub=TRUE"]
    args: list = []
    if niche:
        args.append(niche); where.append(f"c.hub_niche=${len(args)}")
    if category:
        args.append(category); where.append(f"c.hub_category=${len(args)}")
    if city:
        args.append(f"%{city}%"); where.append(f"c.hub_city ILIKE ${len(args)}")
    if q:
        args.append(f"%{q}%"); where.append(f"(c.name ILIKE ${len(args)} OR c.hub_about ILIKE ${len(args)})")
    sql = f"""
        SELECT c.id AS collaborator_id, c.created_by_client_id AS client_id, c.name, c.title,
               c.photo_url, c.hub_category, c.hub_niche, c.hub_city, c.hub_about, c.media_assets,
               c.tg_channel_url, c.vk_url, c.max_url, c.instagram_url, c.website_url,
               (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=c.created_by_client_id) AS collabs_count,
               (SELECT round(avg(CASE WHEN h.participants_total>0 THEN 100.0*h.brought_live/h.participants_total ELSE 0 END))
                  FROM hub_collab_history h WHERE h.client_id=c.created_by_client_id) AS avg_contribution,
               (SELECT round(avg(rating),1) FROM hub_reviews rv WHERE rv.client_id=c.created_by_client_id) AS avg_rating
          FROM collaborators c
         WHERE {' AND '.join(where)}
         ORDER BY collabs_count DESC NULLS LAST, c.hub_published_at DESC NULLS LAST, c.id DESC
         LIMIT 200
    """
    rows = await db.fetch(sql, *args)
    out = []
    for r in rows:
        d = dict(r)
        d['media_tier'] = _media_tier(_sum_subscribers(d.pop('media_assets', None)))
        if media_tier and d['media_tier'] != media_tier:
            continue
        out.append(d)
    return {"items": out, "total": len(out)}


@router.get("/profile/{collaborator_id}")
async def hub_profile(collaborator_id: int, db: asyncpg.Connection = Depends(get_db)):
    """Публичная карточка коллаборатора в Хабе + рейтинг + история + отзывы."""
    c = await db.fetchrow(
        "SELECT * FROM collaborators WHERE id=$1 AND is_published_in_hub=TRUE", collaborator_id
    )
    if not c:
        raise HTTPException(404, "Карточка не опубликована")
    cid = c["created_by_client_id"]
    history = await db.fetch(
        """SELECT h.event_id, e.title AS event_title, h.partner_client_id,
                  pc.name AS partner_name, h.participants_total, h.brought_live, h.created_at
             FROM hub_collab_history h
             LEFT JOIN events e ON e.id=h.event_id
             LEFT JOIN clients pc ON pc.id=h.partner_client_id
            WHERE h.client_id=$1 ORDER BY h.created_at DESC LIMIT 50""", cid)
    reviews = await db.fetch(
        """SELECT rv.rating, rv.text, rv.created_at, ac.name AS author_name
             FROM hub_reviews rv LEFT JOIN clients ac ON ac.id=rv.author_client_id
            WHERE rv.client_id=$1 ORDER BY rv.created_at DESC LIMIT 50""", cid)
    rating = await db.fetchrow(
        """SELECT count(*) AS collabs,
                  round(avg(CASE WHEN participants_total>0 THEN 100.0*brought_live/participants_total ELSE 0 END)) AS avg_contribution
             FROM hub_collab_history WHERE client_id=$1""", cid)
    d = dict(c)
    d['media_tier'] = _media_tier(_sum_subscribers(d.get('media_assets')))
    return {
        "card": {k: d.get(k) for k in (
            'id','name','title','photo_url','hub_category','hub_niche','hub_city','hub_about',
            'media_assets','media_tier','achievements','tg_channel_url','vk_url','max_url',
            'instagram_url','website_url')},
        "rating": {"collabs_count": rating["collabs"], "avg_contribution": rating["avg_contribution"]},
        "history": [dict(h) for h in history],
        "reviews": [dict(r) for r in reviews],
    }
