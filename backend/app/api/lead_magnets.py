"""
Лид-магниты — общая база Клиента (per-client).

Один лид-магнит = один материал (чек-лист, гайд, статья, видео).
Используется в реф-программе любого события клиента (через event_referral_thresholds).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.auth import get_current_client
from app.database import get_db
import asyncpg

router = APIRouter(prefix="/lead-magnets", tags=["Лид-магниты"])


class LeadMagnetIn(BaseModel):
    name: str
    description: Optional[str] = None
    url: str


@router.get("", summary="Список лид-магнитов клиента")
async def list_lead_magnets(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    rows = await db.fetch(
        """SELECT id, name, description, url, created_at, updated_at
           FROM lead_magnets WHERE client_id = $1
           ORDER BY name""",
        int(client["sub"])
    )
    return {"items": [dict(r) for r in rows]}


@router.post("", summary="Создать лид-магнит")
async def create_lead_magnet(
    data: LeadMagnetIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """INSERT INTO lead_magnets (client_id, name, description, url)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, description, url, created_at, updated_at""",
        int(client["sub"]), data.name.strip(), data.description, data.url.strip()
    )
    return dict(row)


@router.get("/{lead_magnet_id}", summary="Получить лид-магнит")
async def get_lead_magnet(
    lead_magnet_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """SELECT id, name, description, url, created_at, updated_at
           FROM lead_magnets WHERE id = $1 AND client_id = $2""",
        lead_magnet_id, int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    return dict(row)


@router.patch("/{lead_magnet_id}", summary="Обновить лид-магнит")
async def update_lead_magnet(
    lead_magnet_id: int,
    data: LeadMagnetIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """UPDATE lead_magnets
              SET name = $1, description = $2, url = $3, updated_at = NOW()
            WHERE id = $4 AND client_id = $5
            RETURNING id, name, description, url, created_at, updated_at""",
        data.name.strip(), data.description, data.url.strip(),
        lead_magnet_id, int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    return dict(row)


@router.delete("/{lead_magnet_id}", summary="Удалить лид-магнит")
async def delete_lead_magnet(
    lead_magnet_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    result = await db.execute(
        "DELETE FROM lead_magnets WHERE id = $1 AND client_id = $2",
        lead_magnet_id, int(client["sub"])
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Лид-магнит не найден")
    return {"ok": True}
