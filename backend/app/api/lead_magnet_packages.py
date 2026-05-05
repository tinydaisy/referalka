"""
Пакеты лид-магнитов — объединение нескольких лид-магнитов под одним
названием и одной публичной ссылкой `pluson.ru/p/{slug}`.

Состав пакета — таблица `lead_magnet_package_items` (M2M c sort_order).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from app.auth import get_current_client
from app.database import get_db
from app.api.lead_magnets import _make_unique_lead_magnet_slug
import asyncpg

router = APIRouter(prefix="/lead-magnet-packages", tags=["Пакеты лид-магнитов"])


class PackageItemIn(BaseModel):
    lead_magnet_id: int
    sort_order: int = 0


class PackageIn(BaseModel):
    name: str
    description: Optional[str] = None
    items: List[PackageItemIn] = []


async def _serialize_package(row, db: asyncpg.Connection) -> dict:
    items = await db.fetch(
        """SELECT pi.lead_magnet_id, pi.sort_order, lm.name, lm.url, lm.slug
             FROM lead_magnet_package_items pi
             JOIN lead_magnets lm ON lm.id = pi.lead_magnet_id
            WHERE pi.package_id = $1
         ORDER BY pi.sort_order, lm.name""",
        row["id"]
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "slug": row["slug"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "items": [dict(i) for i in items],
    }


@router.get("", summary="Список пакетов клиента")
async def list_packages(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    rows = await db.fetch(
        """SELECT id, name, description, slug, created_at, updated_at
             FROM lead_magnet_packages WHERE client_id = $1
            ORDER BY name""",
        int(client["sub"])
    )
    out = []
    for r in rows:
        out.append(await _serialize_package(r, db))
    return {"items": out}


@router.post("", summary="Создать пакет")
async def create_package(
    data: PackageIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Название обязательно")

    # Проверяем что все лид-магниты принадлежат клиенту
    if data.items:
        ids = [i.lead_magnet_id for i in data.items]
        valid = await db.fetchval(
            "SELECT COUNT(*) FROM lead_magnets WHERE id = ANY($1::int[]) AND client_id = $2",
            ids, cid
        )
        if int(valid or 0) != len(set(ids)):
            raise HTTPException(status_code=400, detail="Не все лид-магниты доступны")

    slug = await _make_unique_lead_magnet_slug(db)
    async with db.transaction():
        row = await db.fetchrow(
            """INSERT INTO lead_magnet_packages (client_id, name, description, slug)
               VALUES ($1, $2, $3, $4)
               RETURNING id, name, description, slug, created_at, updated_at""",
            cid, data.name.strip(), data.description, slug
        )
        if data.items:
            await db.executemany(
                """INSERT INTO lead_magnet_package_items (package_id, lead_magnet_id, sort_order)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (package_id, lead_magnet_id) DO NOTHING""",
                [(row["id"], i.lead_magnet_id, i.sort_order) for i in data.items]
            )
    return await _serialize_package(row, db)


@router.get("/{package_id}", summary="Получить пакет")
async def get_package(
    package_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """SELECT id, name, description, slug, created_at, updated_at
             FROM lead_magnet_packages WHERE id = $1 AND client_id = $2""",
        package_id, int(client["sub"])
    )
    if not row:
        raise HTTPException(status_code=404, detail="Пакет не найден")
    return await _serialize_package(row, db)


@router.patch("/{package_id}", summary="Обновить пакет")
async def update_package(
    package_id: int,
    data: PackageIn,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    if not data.name.strip():
        raise HTTPException(status_code=400, detail="Название обязательно")

    if data.items:
        ids = [i.lead_magnet_id for i in data.items]
        valid = await db.fetchval(
            "SELECT COUNT(*) FROM lead_magnets WHERE id = ANY($1::int[]) AND client_id = $2",
            ids, cid
        )
        if int(valid or 0) != len(set(ids)):
            raise HTTPException(status_code=400, detail="Не все лид-магниты доступны")

    async with db.transaction():
        row = await db.fetchrow(
            """UPDATE lead_magnet_packages
                  SET name = $1, description = $2, updated_at = NOW()
                WHERE id = $3 AND client_id = $4
                RETURNING id, name, description, slug, created_at, updated_at""",
            data.name.strip(), data.description, package_id, cid
        )
        if not row:
            raise HTTPException(status_code=404, detail="Пакет не найден")
        await db.execute(
            "DELETE FROM lead_magnet_package_items WHERE package_id = $1",
            package_id
        )
        if data.items:
            await db.executemany(
                """INSERT INTO lead_magnet_package_items (package_id, lead_magnet_id, sort_order)
                   VALUES ($1, $2, $3)""",
                [(package_id, i.lead_magnet_id, i.sort_order) for i in data.items]
            )
    return await _serialize_package(row, db)


@router.delete("/{package_id}", summary="Удалить пакет")
async def delete_package(
    package_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    result = await db.execute(
        "DELETE FROM lead_magnet_packages WHERE id = $1 AND client_id = $2",
        package_id, int(client["sub"])
    )
    if result.endswith("0"):
        raise HTTPException(status_code=404, detail="Пакет не найден")
    return {"ok": True}


@router.get("/{package_id}/analytics", summary="Аналитика воронки пакета")
async def package_analytics(
    package_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    cid = int(client["sub"])
    own = await db.fetchval(
        "SELECT 1 FROM lead_magnet_packages WHERE id = $1 AND client_id = $2",
        package_id, cid
    )
    if not own:
        raise HTTPException(status_code=404, detail="Пакет не найден")

    counts = await db.fetchrow(
        """SELECT
              COUNT(*) FILTER (WHERE stage IN ('landed','started','subscribed','delivered')) AS landed,
              COUNT(*) FILTER (WHERE stage IN ('started','subscribed','delivered'))         AS started,
              COUNT(*) FILTER (WHERE stage = 'delivered')                                    AS delivered
             FROM funnel_runs
            WHERE package_id = $1""",
        package_id
    )

    runs = await db.fetch(
        """SELECT
              fr.id, fr.stage, fr.utm, fr.landed_at, fr.started_at,
              fr.subscribed_at, fr.delivered_at,
              fr.contact_id, c.name AS contact_name,
              fr.platform_slug, fr.platform_user_id,
              pu.username AS contact_username,
              fr.referrer_contact_id, rc.name AS referrer_name,
              rpu.username AS referrer_username
             FROM funnel_runs fr
        LEFT JOIN contacts c ON c.id = fr.contact_id
        LEFT JOIN platform_users pu
               ON pu.contact_id = fr.contact_id
              AND pu.platform_slug = fr.platform_slug
        LEFT JOIN contacts rc ON rc.id = fr.referrer_contact_id
        LEFT JOIN platform_users rpu
               ON rpu.contact_id = fr.referrer_contact_id
              AND rpu.platform_slug = fr.platform_slug
            WHERE fr.package_id = $1
         ORDER BY fr.landed_at DESC
            LIMIT 500""",
        package_id
    )

    return {
        "counts": {
            "landed": int(counts["landed"] or 0),
            "started": int(counts["started"] or 0),
            "delivered": int(counts["delivered"] or 0),
        },
        "runs": [dict(r) for r in runs],
    }
