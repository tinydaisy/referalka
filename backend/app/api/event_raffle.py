"""
Розыгрыш на событии — настройки, призы, кодовые слова.

Используется в дашборде клиента (карточка события → вкладка Розыгрыш)
и в Mini App (общая вкладка 🎟 Розыгрыш).

API:
  Settings:
    GET   /api/v1/events/{event_id}/raffle/settings
    PUT   /api/v1/events/{event_id}/raffle/settings
  Prizes:
    GET   /api/v1/events/{event_id}/raffle/prizes
    POST  /api/v1/events/{event_id}/raffle/prizes
    PATCH /api/v1/events/{event_id}/raffle/prizes/{prize_id}
    DELETE /api/v1/events/{event_id}/raffle/prizes/{prize_id}
  Keywords:
    GET   /api/v1/events/{event_id}/raffle/keywords
    POST  /api/v1/events/{event_id}/raffle/keywords
    PATCH /api/v1/events/{event_id}/raffle/keywords/{kw_id}
    DELETE /api/v1/events/{event_id}/raffle/keywords/{kw_id}

Создано миграцией 042 (event_raffle_settings, event_raffle_prizes, event_raffle_keywords).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Any
from datetime import datetime
import asyncpg

from app.database import get_db
from app.auth import get_current_client


router = APIRouter(prefix="/events/{event_id}/raffle", tags=["Розыгрыш события"])


async def _check_event_access(db, client_id: int, event_id: int):
    row = await db.fetchrow("SELECT id FROM events WHERE id = $1 AND client_id = $2", event_id, client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Событие не найдено или нет доступа")


# ─────── SETTINGS ───────
class RaffleSettingsIn(BaseModel):
    is_enabled: bool = False
    draw_at: Optional[datetime] = None
    subscription_grants_starter_ticket: bool = True
    intro_text: Optional[str] = None


@router.get("/settings", summary="Настройки розыгрыша на событии")
async def get_settings(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    row = await db.fetchrow(
        "SELECT is_enabled, draw_at, subscription_grants_starter_ticket, intro_text FROM event_raffle_settings WHERE event_id = $1",
        event_id,
    )
    if not row:
        return {"is_enabled": False, "draw_at": None, "subscription_grants_starter_ticket": True, "intro_text": None}
    return dict(row)


@router.put("/settings", summary="Сохранить настройки розыгрыша")
async def upsert_settings(
    event_id: int,
    data: RaffleSettingsIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    row = await db.fetchrow(
        """INSERT INTO event_raffle_settings (event_id, is_enabled, draw_at, subscription_grants_starter_ticket, intro_text)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (event_id) DO UPDATE SET
              is_enabled = EXCLUDED.is_enabled,
              draw_at = EXCLUDED.draw_at,
              subscription_grants_starter_ticket = EXCLUDED.subscription_grants_starter_ticket,
              intro_text = EXCLUDED.intro_text,
              updated_at = NOW()
           RETURNING is_enabled, draw_at, subscription_grants_starter_ticket, intro_text""",
        event_id, data.is_enabled, data.draw_at, data.subscription_grants_starter_ticket, data.intro_text,
    )
    return dict(row)


# ─────── PRIZES ───────
class PrizeIn(BaseModel):
    title: str
    description: Optional[str] = None
    icon_emoji: Optional[str] = None
    icon_url: Optional[str] = None
    places_count: int = 1
    value_label: Optional[str] = None
    sort_order: int = 0
    is_active: bool = True


class PrizePatch(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    icon_emoji: Optional[str] = None
    icon_url: Optional[str] = None
    places_count: Optional[int] = None
    value_label: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


@router.get("/prizes", summary="Призы розыгрыша")
async def list_prizes(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """SELECT id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active
             FROM event_raffle_prizes WHERE event_id = $1 ORDER BY sort_order, id""",
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/prizes", summary="Создать приз")
async def create_prize(
    event_id: int,
    data: PrizeIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    row = await db.fetchrow(
        """INSERT INTO event_raffle_prizes
           (event_id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active""",
        event_id, data.title, data.description, data.icon_emoji, data.icon_url,
        data.places_count, data.value_label, data.sort_order, data.is_active,
    )
    return dict(row)


@router.patch("/prizes/{prize_id}", summary="Обновить приз")
async def update_prize(
    event_id: int,
    prize_id: int,
    data: PrizePatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    sets, args = [], []
    for f in ("title","description","icon_emoji","icon_url","places_count","value_label","sort_order","is_active"):
        v = getattr(data, f)
        if v is not None:
            sets.append(f"{f} = ${len(args)+1}")
            args.append(v)
    if not sets:
        raise HTTPException(400, "Нечего обновлять")
    args.extend([prize_id, event_id])
    row = await db.fetchrow(
        f"""UPDATE event_raffle_prizes SET {', '.join(sets)}, updated_at = NOW()
            WHERE id = ${len(args)-1} AND event_id = ${len(args)}
            RETURNING id, title, description, icon_emoji, icon_url, places_count, value_label, sort_order, is_active""",
        *args,
    )
    if not row:
        raise HTTPException(404, "Приз не найден")
    return dict(row)


@router.delete("/prizes/{prize_id}", summary="Удалить приз")
async def delete_prize(event_id: int, prize_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    res = await db.execute("DELETE FROM event_raffle_prizes WHERE id = $1 AND event_id = $2", prize_id, event_id)
    if res.endswith(" 0"):
        raise HTTPException(404, "Приз не найден")
    return {"ok": True}


# ─────── KEYWORDS ───────
class KeywordIn(BaseModel):
    keyword: str
    tickets_reward: int = 1
    sort_order: int = 0
    is_active: bool = True


class KeywordPatch(BaseModel):
    keyword: Optional[str] = None
    tickets_reward: Optional[int] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


@router.get("/keywords", summary="Кодовые слова розыгрыша")
async def list_keywords(event_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    rows = await db.fetch(
        """SELECT id, keyword, tickets_reward, sort_order, is_active
             FROM event_raffle_keywords WHERE event_id = $1 ORDER BY sort_order, id""",
        event_id,
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/keywords", summary="Создать кодовое слово")
async def create_keyword(
    event_id: int,
    data: KeywordIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    kw = data.keyword.strip()
    if not kw:
        raise HTTPException(400, "keyword обязателен")
    try:
        row = await db.fetchrow(
            """INSERT INTO event_raffle_keywords
               (event_id, keyword, keyword_lower, tickets_reward, sort_order, is_active)
               VALUES ($1,$2,$3,$4,$5,$6)
               RETURNING id, keyword, tickets_reward, sort_order, is_active""",
            event_id, kw, kw.lower(), data.tickets_reward, data.sort_order, data.is_active,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "Это кодовое слово уже добавлено")
    return dict(row)


@router.patch("/keywords/{kw_id}", summary="Обновить кодовое слово")
async def update_keyword(
    event_id: int,
    kw_id: int,
    data: KeywordPatch,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db),
):
    await _check_event_access(db, int(client["sub"]), event_id)
    sets, args = [], []
    for f in ("tickets_reward","sort_order","is_active"):
        v = getattr(data, f)
        if v is not None:
            sets.append(f"{f} = ${len(args)+1}")
            args.append(v)
    if data.keyword is not None:
        kw = data.keyword.strip()
        sets.append(f"keyword = ${len(args)+1}");        args.append(kw)
        sets.append(f"keyword_lower = ${len(args)+1}");  args.append(kw.lower())
    if not sets:
        raise HTTPException(400, "Нечего обновлять")
    args.extend([kw_id, event_id])
    row = await db.fetchrow(
        f"""UPDATE event_raffle_keywords SET {', '.join(sets)}
            WHERE id = ${len(args)-1} AND event_id = ${len(args)}
            RETURNING id, keyword, tickets_reward, sort_order, is_active""",
        *args,
    )
    if not row:
        raise HTTPException(404, "Кодовое слово не найдено")
    return dict(row)


@router.delete("/keywords/{kw_id}", summary="Удалить кодовое слово")
async def delete_keyword(event_id: int, kw_id: int, client=Depends(get_current_client), db: asyncpg.Connection = Depends(get_db)):
    await _check_event_access(db, int(client["sub"]), event_id)
    res = await db.execute("DELETE FROM event_raffle_keywords WHERE id = $1 AND event_id = $2", kw_id, event_id)
    if res.endswith(" 0"):
        raise HTTPException(404, "Кодовое слово не найдено")
    return {"ok": True}
