"""
Коллабораторная (Хаб) — биржа коллабораций между клиентами ПЛЮСОНа.

⚠️ Карточка в Хабе = профиль КЛИЕНТА-организатора (clients), а НЕ коллаборатора (collaborators).
Коллаборатор = спикер/жюри в чьём-то событии — ДРУГОЙ слой. Карточка тянет:
фото основателя (owner_photo_url / profile_photo_url), бренд (brand_name), био (bio),
регалии (owner_achievements), соцсети/каналы (social_links), медийность (clients.media_assets).
Хаб-специфика на clients: is_published_in_hub, hub_category/niche/city/about (миграция 135).

Термины: ВЛАДЕЛЬЦЫ совместного события = «Организаторы» (event_owners, клиенты-совладельцы).
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
import asyncpg
import json

router = APIRouter(prefix="/collab-hub", tags=["Коллабораторная (Хаб)"])

HUB_CATEGORIES = ['offline_business', 'online_business', 'freelancer', 'expert']


def _media_tier(total_subs: int) -> str:
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
        arr = media_assets if isinstance(media_assets, list) else json.loads(media_assets)
        return sum(int(a.get('subscribers') or 0) for a in arr if isinstance(a, dict))
    except Exception:
        return 0


def _client_card(row) -> dict:
    """Собирает карточку организатора из строки clients."""
    d = dict(row)
    ma = d.get('media_assets')
    if isinstance(ma, str):
        try: ma = json.loads(ma)
        except Exception: ma = []
    name = d.get('brand_name') or d.get('name')
    return {
        'client_id': d.get('id'),
        'name': name,
        'brand_name': d.get('brand_name'),
        'photo_url': d.get('owner_photo_url') or d.get('profile_photo_url'),
        'bio': d.get('bio'),
        'positioning': d.get('owner_positioning') or d.get('positioning'),
        'achievements': d.get('owner_achievements'),
        'social_links': d.get('social_links'),
        'media_assets': ma or [],
        'media_tier': _media_tier(_sum_subscribers(ma)),
        'is_published_in_hub': d.get('is_published_in_hub'),
        'hub_category': d.get('hub_category'),
        'hub_niche': d.get('hub_niche'),
        'hub_city': d.get('hub_city'),
        'hub_about': d.get('hub_about'),
    }


_CLIENT_COLS = """id, name, brand_name, owner_photo_url, profile_photo_url, bio,
    owner_positioning, positioning, owner_achievements, social_links, media_assets,
    is_published_in_hub, hub_category, hub_niche, hub_city, hub_about"""


# ═══════════════════════════════════════════════════════════════
# Справочник ниш
# ═══════════════════════════════════════════════════════════════
@router.get("/niches")
async def list_niches(db: asyncpg.Connection = Depends(get_db)):
    rows = await db.fetch("SELECT slug, title FROM hub_niches ORDER BY sort_order, title")
    return {"niches": [dict(r) for r in rows]}


# ═══════════════════════════════════════════════════════════════
# Моя карточка в Хабе = мой профиль организатора (clients)
# ═══════════════════════════════════════════════════════════════
class HubCardIn(BaseModel):
    is_published_in_hub: bool = True
    hub_category: Optional[str] = None
    hub_niche: Optional[str] = None
    hub_city: Optional[str] = None
    hub_about: Optional[str] = None
    media_assets: Optional[list] = None   # [{platform, subscribers}]


@router.get("/me/card")
async def get_my_card(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Моя карточка организатора — данные из профиля (clients). Редактируется фото/регалии в настройках Mini App."""
    row = await db.fetchrow(f"SELECT {_CLIENT_COLS} FROM clients WHERE id=$1", int(client["sub"]))
    if not row:
        raise HTTPException(404, "Клиент не найден")
    return {"card": _client_card(row)}


@router.post("/me/card")
async def publish_my_card(data: HubCardIn, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Опубликовать/обновить свою карточку в Хабе (флаг + категория/ниша/город/о себе/медийность на clients)."""
    if data.hub_category and data.hub_category not in HUB_CATEGORIES:
        raise HTTPException(400, "Неизвестная категория")
    cid = int(client["sub"])
    ma = json.dumps(data.media_assets) if data.media_assets is not None else None
    await db.execute(
        """UPDATE clients
              SET is_published_in_hub=$2, hub_category=$3, hub_niche=$4, hub_city=$5, hub_about=$6,
                  media_assets=COALESCE($7::jsonb, media_assets),
                  hub_published_at=CASE WHEN $2 AND hub_published_at IS NULL THEN NOW() ELSE hub_published_at END
            WHERE id=$1""",
        cid, data.is_published_in_hub, data.hub_category, data.hub_niche, data.hub_city, data.hub_about, ma
    )
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# Каталог Хаба — поиск партнёров (организаторов-клиентов)
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
    where = ["cl.is_published_in_hub=TRUE", "cl.id<>$1"]
    args: list = [int(client["sub"])]
    if niche:
        args.append(niche); where.append(f"cl.hub_niche=${len(args)}")
    if category:
        args.append(category); where.append(f"cl.hub_category=${len(args)}")
    if city:
        args.append(f"%{city}%"); where.append(f"cl.hub_city ILIKE ${len(args)}")
    if q:
        args.append(f"%{q}%"); where.append(f"(COALESCE(cl.brand_name,cl.name) ILIKE ${len(args)} OR cl.hub_about ILIKE ${len(args)})")
    sql = f"""
        SELECT {_CLIENT_COLS},
               (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=cl.id) AS collabs_count,
               (SELECT round(avg(CASE WHEN h.participants_total>0 THEN 100.0*h.brought_live/h.participants_total ELSE 0 END))
                  FROM hub_collab_history h WHERE h.client_id=cl.id) AS avg_contribution,
               (SELECT round(avg(rating),1) FROM hub_reviews rv WHERE rv.client_id=cl.id) AS avg_rating
          FROM clients cl
         WHERE {' AND '.join(where)}
         ORDER BY collabs_count DESC NULLS LAST, cl.hub_published_at DESC NULLS LAST, cl.id DESC
         LIMIT 200
    """
    rows = await db.fetch(sql, *args)
    out = []
    for r in rows:
        card = _client_card(r)
        card['collabs_count'] = r['collabs_count']
        card['avg_contribution'] = r['avg_contribution']
        card['avg_rating'] = r['avg_rating']
        if media_tier and card['media_tier'] != media_tier:
            continue
        out.append(card)
    return {"items": out, "total": len(out)}


@router.get("/profile/{client_id}")
async def hub_profile(client_id: int, db: asyncpg.Connection = Depends(get_db)):
    """Публичная карточка организатора в Хабе + рейтинг + история + отзывы."""
    row = await db.fetchrow(
        f"SELECT {_CLIENT_COLS} FROM clients WHERE id=$1 AND is_published_in_hub=TRUE", client_id)
    if not row:
        raise HTTPException(404, "Карточка не опубликована")
    history = await db.fetch(
        """SELECT h.event_id, e.title AS event_title, h.partner_client_id,
                  COALESCE(pc.brand_name,pc.name) AS partner_name, h.participants_total, h.brought_live, h.created_at
             FROM hub_collab_history h
             LEFT JOIN events e ON e.id=h.event_id
             LEFT JOIN clients pc ON pc.id=h.partner_client_id
            WHERE h.client_id=$1 ORDER BY h.created_at DESC LIMIT 50""", client_id)
    reviews = await db.fetch(
        """SELECT rv.rating, rv.text, rv.created_at, COALESCE(ac.brand_name,ac.name) AS author_name
             FROM hub_reviews rv LEFT JOIN clients ac ON ac.id=rv.author_client_id
            WHERE rv.client_id=$1 ORDER BY rv.created_at DESC LIMIT 50""", client_id)
    rating = await db.fetchrow(
        """SELECT count(*) AS collabs,
                  round(avg(CASE WHEN participants_total>0 THEN 100.0*brought_live/participants_total ELSE 0 END)) AS avg_contribution
             FROM hub_collab_history WHERE client_id=$1""", client_id)
    return {
        "card": _client_card(row),
        "rating": {"collabs_count": rating["collabs"], "avg_contribution": rating["avg_contribution"]},
        "history": [dict(h) for h in history],
        "reviews": [dict(r) for r in reviews],
    }
