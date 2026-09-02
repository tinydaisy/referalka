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
from app.api.lead_magnets import _make_unique_lead_magnet_slug, _public_base
from app.services.share_links import build_funnel_landing_links
import asyncpg

router = APIRouter(prefix="/lead-magnet-packages", tags=["Пакеты лид-магнитов"])


class PackageItemIn(BaseModel):
    lead_magnet_id: int
    sort_order: int = 0


class PackageIn(BaseModel):
    name: str
    description: Optional[str] = None
    # Как отдавать ВСЕ материалы пакета: text / button / both.
    # ⚠️ Значение пакета ПЕРЕБИВАЕТ настройку каждого материала (миграция 330):
    # иначе часть пунктов ушла бы кнопками, часть текстом, а нумерация подписей
    # разъехалась бы со списком. None — не задано, решает сам материал.
    link_mode: Optional[str] = None
    items: List[PackageItemIn] = []


def _norm_pkg_link_mode(v):
    """Режим выдачи пакета. Мусор и пустое → None («решает материал»)."""
    return v if v in ('text', 'button', 'both') else None


async def _serialize_package(row, db: asyncpg.Connection) -> dict:
    items = await db.fetch(
        """SELECT pi.lead_magnet_id, pi.sort_order, lm.name, lm.url, lm.slug
             FROM lead_magnet_package_items pi
             JOIN lead_magnets lm ON lm.id = pi.lead_magnet_id
            WHERE pi.package_id = $1
         ORDER BY pi.sort_order, lm.name""",
        row["id"]
    )
    platform_links = await build_funnel_landing_links(
        db, client_id=row["client_id"], slug=row["slug"], kind='p',
        base_url=await _public_base(db, row["client_id"])
    )
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "link_mode": row["link_mode"],
        "slug": row["slug"],
        "platform_links": platform_links,
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
        """SELECT id, client_id, name, description, slug, link_mode, created_at, updated_at
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
            """INSERT INTO lead_magnet_packages (client_id, name, description, slug, link_mode)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, client_id, name, description, slug, link_mode, created_at, updated_at""",
            cid, data.name.strip(), data.description, slug,
            _norm_pkg_link_mode(data.link_mode),
        )
        if data.items:
            await db.executemany(
                """INSERT INTO lead_magnet_package_items (package_id, lead_magnet_id, sort_order)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (package_id, lead_magnet_id) DO NOTHING""",
                [(row["id"], i.lead_magnet_id, i.sort_order) for i in data.items]
            )
    return await _serialize_package(row, db)


@router.get("/counts", summary="Батч-счётчики воронки по всем пакетам клиента")
async def list_counts(
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    # `known` / `delivered` / `not_delivered` считаются по ЖИВЫМ контактам клиента
    # (contacts.is_active) — ровно та же выборка, что у фильтра /dashboard/clients,
    # чтобы цифра на плитке совпадала с числом строк в списке контактов.
    rows = await db.fetch(
        """SELECT
              pkg.id,
              COALESCE(COUNT(fr.id) FILTER (WHERE fr.stage IN ('landed','started','subscribed','delivered')), 0) AS landed,
              COALESCE(COUNT(DISTINCT c.id), 0) AS known,
              COALESCE(COUNT(DISTINCT c.id) FILTER (WHERE fr.stage IN ('started','subscribed','delivered')), 0) AS started,
              COALESCE(COUNT(DISTINCT c.id) FILTER (WHERE fr.stage = 'delivered'), 0) AS delivered
             FROM lead_magnet_packages pkg
        LEFT JOIN funnel_runs fr ON fr.package_id = pkg.id
        LEFT JOIN contacts c ON c.id = fr.contact_id
                            AND c.is_active = TRUE
                            AND c.client_id = pkg.client_id
            WHERE pkg.client_id = $1
         GROUP BY pkg.id""",
        int(client["sub"])
    )
    return {"items": [
        {
            "id": r["id"],
            "landed": int(r["landed"]),
            "known": int(r["known"]),
            "started": int(r["started"]),
            "delivered": int(r["delivered"]),
            # «не забрали» = зашли по ссылке, но ни один их run не дошёл до delivered
            "not_delivered": int(r["known"]) - int(r["delivered"]),
        }
        for r in rows
    ]}


@router.get("/{package_id}", summary="Получить пакет")
async def get_package(
    package_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    row = await db.fetchrow(
        """SELECT id, client_id, name, description, slug, link_mode, created_at, updated_at
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
                  SET name = $1, description = $2,
                      -- Правим только присланное: форма может слать не все поля.
                      link_mode = CASE WHEN $5 THEN $6 ELSE link_mode END,
                      updated_at = NOW()
                WHERE id = $3 AND client_id = $4
                RETURNING id, client_id, name, description, slug, link_mode, created_at, updated_at""",
            data.name.strip(), data.description, package_id, cid,
            'link_mode' in data.model_fields_set, _norm_pkg_link_mode(data.link_mode),
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


@router.get("/{package_id}/crm", summary="CRM пакета: люди по этапам")
async def package_crm_view(
    package_id: int,
    client=Depends(get_current_client),
    db: asyncpg.Connection = Depends(get_db)
):
    """То же, что у лид-магнита: колонки этапов со списками людей."""
    from app.services.lead_magnet_crm import lead_magnet_crm
    data = await lead_magnet_crm(
        db, client_id=int(client["sub"]), package_id=package_id)
    if not data:
        raise HTTPException(status_code=404, detail="Пакет не найден")
    return data
