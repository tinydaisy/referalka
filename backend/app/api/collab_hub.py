"""
Коллабораторная (Хаб) — биржа коллабораций между клиентами ПЛЮСОНа.

⚠️ Карточка в Хабе = профиль КЛИЕНТА-организатора (clients), а НЕ коллаборатора (collaborators).
Коллаборатор = спикер/жюри в чьём-то событии — ДРУГОЙ слой. Карточка тянет:
фото основателя (owner_photo_url / profile_photo_url), бренд (brand_name), био (bio),
регалии (owner_achievements), соцсети/каналы (social_links), медийность (clients.media_assets).
Хаб-специфика на clients: is_published_in_hub, hub_category/niche/city/about (миграция 135),
hub_impact/hub_wow + галочки *_public (миграция 218).

Термины: ВЛАДЕЛЬЦЫ совместного события = «Организаторы» (event_owners, клиенты-совладельцы).
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
from app.services.features import client_has_feature
import asyncpg
import json


async def require_collab_hub(client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Гейт: Коллабораторная доступна только со 2-го тарифа (фича collab_hub — pro/vip/trial, не start)."""
    if not await client_has_feature(db, int(client["sub"]), "collab_hub"):
        raise HTTPException(403, "Коллабораторная доступна на тарифе ПРОФИ и выше")
    return client


router = APIRouter(prefix="/collab-hub", tags=["Коллабораторная (Хаб)"],
                   dependencies=[Depends(require_collab_hub)])

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


def _parse_json(v, default):
    """JSONB из asyncpg часто приходит строкой — парсим в list/dict для фронта."""
    if v is None:
        return default
    if isinstance(v, str):
        try: return json.loads(v)
        except Exception: return default
    return v


def _client_card(row, public: bool = False) -> dict:
    """Собирает карточку организатора из строки clients.

    ⚠️ name (заголовок карточки) = ИМЯ ОСНОВАТЕЛЯ (clients.name) — человек, а не бренд.
    Название проекта отдаём отдельно (brand_name) — фронт рисует строкой «Проект: …».
    Раньше name = brand_name || name, из-за чего имя основателя терялось.

    public=True — карточка отдаётся ДРУГОМУ клиенту (каталог/профиль). Тогда поля
    hub_impact/hub_wow скрываются, если сняты галочки *_public. Владельцу своей
    карточки (public=False) поля отдаём всегда — он их редактирует.
    """
    d = dict(row)
    ma = _parse_json(d.get('media_assets'), [])
    impact_public = d.get('hub_impact_public')
    wow_public = d.get('hub_wow_public')
    return {
        'client_id': d.get('id'),
        'name': d.get('name') or d.get('brand_name'),
        'owner_name': d.get('name'),
        'brand_name': d.get('brand_name'),
        'photo_url': d.get('owner_photo_url') or d.get('profile_photo_url'),
        'bio': d.get('bio'),
        'positioning': d.get('owner_positioning') or d.get('positioning'),
        'achievements': _parse_json(d.get('owner_achievements'), []),
        'social_links': _parse_json(d.get('social_links'), {}),
        'media_assets': ma or [],
        'media_tier': _media_tier(_sum_subscribers(ma)),
        'is_published_in_hub': d.get('is_published_in_hub'),
        'hub_category': d.get('hub_category'),
        'hub_niche': d.get('hub_niche'),
        'hub_city': d.get('hub_city'),
        'hub_about': d.get('hub_about'),
        'hub_impact': (None if public and not impact_public else d.get('hub_impact')),
        'hub_impact_public': impact_public,
        'hub_wow': (None if public and not wow_public else d.get('hub_wow')),
        'hub_wow_public': wow_public,
    }


_CLIENT_COLS = """id, name, brand_name, owner_photo_url, profile_photo_url, bio,
    owner_positioning, positioning, owner_achievements, social_links, media_assets,
    is_published_in_hub, hub_category, hub_niche, hub_city, hub_about,
    hub_impact, hub_impact_public, hub_wow, hub_wow_public"""


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
    hub_impact: Optional[str] = None        # «Что я создаю и меняю в стране/мире…»
    hub_impact_public: bool = True          # показывать impact в публичной карточке
    hub_wow: Optional[str] = None           # «Капелька безумия / WOW-факт»
    hub_wow_public: bool = True             # показывать wow в публичной карточке
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
                  hub_impact=$8, hub_impact_public=$9, hub_wow=$10, hub_wow_public=$11,
                  hub_published_at=CASE WHEN $2 AND hub_published_at IS NULL THEN NOW() ELSE hub_published_at END
            WHERE id=$1""",
        cid, data.is_published_in_hub, data.hub_category, data.hub_niche, data.hub_city, data.hub_about, ma,
        data.hub_impact, data.hub_impact_public, data.hub_wow, data.hub_wow_public
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
        # Ищем и по имени основателя, и по названию проекта (бренду), и по «что предлагает».
        args.append(f"%{q}%")
        where.append(f"(cl.name ILIKE ${len(args)} OR cl.brand_name ILIKE ${len(args)} OR cl.hub_about ILIKE ${len(args)})")
    sql = f"""
        SELECT {_CLIENT_COLS},
               (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=cl.id) AS collabs_count,
               -- Win-Win коэффициент: среднее по коллабам клиента (миграция 268).
               -- Коллабы без коэффициента (один организатор / никто никого не
               -- привёл) в среднее НЕ входят — иначе тянули бы показатель вниз.
               (SELECT round(avg(h.win_win_coefficient), 2)
                  FROM hub_collab_history h
                 WHERE h.client_id=cl.id AND h.win_win_coefficient IS NOT NULL) AS win_win,
               (SELECT round(avg(rating),1) FROM hub_reviews rv WHERE rv.client_id=cl.id) AS avg_rating
          FROM clients cl
         WHERE {' AND '.join(where)}
         ORDER BY collabs_count DESC NULLS LAST, cl.hub_published_at DESC NULLS LAST, cl.id DESC
         LIMIT 200
    """
    rows = await db.fetch(sql, *args)
    out = []
    for r in rows:
        card = _client_card(r, public=True)  # чужие карточки — уважаем галочки *_public
        card['collabs_count'] = r['collabs_count']
        card['win_win'] = float(r['win_win']) if r['win_win'] is not None else None
        card['avg_rating'] = r['avg_rating']
        if media_tier and card['media_tier'] != media_tier:
            continue
        out.append(card)
    # Моя собственная карточка — показывается ВВЕРХУ списка, подсвеченная (даже если не опубликована — видна только мне)
    me_row = await db.fetchrow(
        f"""SELECT {_CLIENT_COLS},
               (SELECT count(*) FROM hub_collab_history h WHERE h.client_id=cl.id) AS collabs_count,
               -- Win-Win коэффициент: среднее по коллабам клиента (миграция 268).
               -- Коллабы без коэффициента (один организатор / никто никого не
               -- привёл) в среднее НЕ входят — иначе тянули бы показатель вниз.
               (SELECT round(avg(h.win_win_coefficient), 2)
                  FROM hub_collab_history h
                 WHERE h.client_id=cl.id AND h.win_win_coefficient IS NOT NULL) AS win_win,
               (SELECT round(avg(rating),1) FROM hub_reviews rv WHERE rv.client_id=cl.id) AS avg_rating
          FROM clients cl WHERE cl.id=$1""", int(client["sub"]))
    me_card = None
    if me_row:
        me_card = _client_card(me_row)
        me_card['collabs_count'] = me_row['collabs_count']
        me_card['win_win'] = float(me_row['win_win']) if me_row['win_win'] is not None else None
        me_card['avg_rating'] = me_row['avg_rating']
        me_card['is_me'] = True
    return {"me": me_card, "items": out, "total": len(out)}


@router.get("/profile/{client_id}")
async def hub_profile(client_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    """Карточка организатора в Хабе + рейтинг + история + отзывы + контакты для связи.
    Виден если опубликован ИЛИ между нами есть запрос на коллаборацию."""
    me = int(client["sub"])
    row = await db.fetchrow(
        f"SELECT {_CLIENT_COLS}, telegram_username FROM clients WHERE id=$1", client_id)
    if not row:
        raise HTTPException(404, "Организатор не найден")
    has_link = await db.fetchval(
        """SELECT 1 FROM hub_collab_requests
            WHERE (from_client_id=$1 AND to_client_id=$2) OR (from_client_id=$2 AND to_client_id=$1) LIMIT 1""",
        me, client_id)
    if not row["is_published_in_hub"] and not has_link and me != client_id:
        raise HTTPException(403, "Карточка не опубликована")
    my_review = await db.fetchrow(
        "SELECT rating, text FROM hub_reviews WHERE client_id=$1 AND author_client_id=$2", client_id, me)
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
                  round(avg(win_win_coefficient), 2) FILTER (WHERE win_win_coefficient IS NOT NULL) AS win_win
             FROM hub_collab_history WHERE client_id=$1""", client_id)
    card = _client_card(row, public=(me != client_id))  # свой профиль — поля видны всегда
    card['telegram_username'] = row.get('telegram_username')
    return {
        "card": card,
        "rating": {"collabs_count": rating["collabs"],
                   "win_win": float(rating["win_win"]) if rating["win_win"] is not None else None},
        "history": [dict(h) for h in history],
        "reviews": [dict(r) for r in reviews],
        "my_review": dict(my_review) if my_review else None,
        "is_me": me == client_id,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Закрытый чат Коллабораторной (миграция 264)
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/settings", summary="Настройки Коллабораторной (ссылка на чат)")
async def get_collab_hub_settings(db=Depends(get_db)):
    """Ссылки на закрытый чат участников — Telegram и MAX (миграция 266).

    Одни на всю Коллабораторную (таблица-одиночка, id=1). Обе пусты → в кабинете
    пункт «Закрытый чат» просто не показывается, а не ведёт в никуда.
    """
    row = await db.fetchrow(
        "SELECT chat_url, chat_url_max, chat_title FROM collab_hub_settings WHERE id = 1")
    return {
        "chat_url": (row["chat_url"] if row else None) or "",
        "chat_url_max": (row["chat_url_max"] if row else None) or "",
        "chat_title": (row["chat_title"] if row else None) or "Закрытый чат",
    }
